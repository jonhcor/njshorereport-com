// ─────────────────────────────────────────────────────────────
// Shore Report — Weekly Conditions Worker
// Runs every Friday at 7am ET via cron trigger
// Fetches live data, calls Claude for narrative, stores in KV
//
// Required bindings (set in Cloudflare dashboard):
//   KV namespace: REPORTS
//   Secret:       ANTHROPIC_API_KEY
// ─────────────────────────────────────────────────────────────

const ZONES = [
  { name: 'Sandy Hook',     lat: 40.467, lon: -74.008, type: 'coast'  },
  { name: 'Point Pleasant', lat: 40.082, lon: -74.042, type: 'inlet'  },
  { name: 'Barnegat Inlet', lat: 39.759, lon: -74.104, type: 'inlet'  },
  { name: 'Atlantic City',  lat: 39.364, lon: -74.422, type: 'coast'  },
  { name: 'Cape May',       lat: 38.935, lon: -74.902, type: 'inlet'  },
  { name: 'Hudson Canyon',  lat: 38.500, lon: -72.500, type: 'canyon' },
];

// ── Helpers ──────────────────────────────────────────────────
const c2f = c => c * 9/5 + 32;
const m2ft = m => m * 3.28084;

function scoreZone(wind, waveH, sstF, isCanyon){
  let s = 100;
  const threshold = isCanyon ? 12 : 15;
  if(wind > 20)        s -= isCanyon ? 45 : 35;
  else if(wind > threshold) s -= isCanyon ? 30 : 20;
  else if(wind > 10)   s -= 10;
  if(waveH > 6)        s -= 35;
  else if(waveH > 4)   s -= isCanyon ? 30 : 18;
  else if(waveH > 2.5) s -= 10;
  return Math.max(0, Math.round(s));
}

function verdict(score){ return score >= 68 ? 'GO FISH' : score >= 42 ? 'BORDERLINE' : 'STAY IN'; }

function activeSpecies(sstF){
  const sp = [];
  if(sstF >= 60 && sstF <= 76) sp.push('Fluke');
  if(sstF >= 48 && sstF <= 68) sp.push('Striped Bass');
  if(sstF >= 58 && sstF <= 74) sp.push('Bluefish');
  if(sstF >= 44 && sstF <= 54) sp.push('Winter Flounder');
  if(sstF >= 48 && sstF <= 62) sp.push('Tautog');
  if(sstF >= 52 && sstF <= 68) sp.push('Black Sea Bass');
  if(sstF >= 58 && sstF <= 70) sp.push('Weakfish');
  if(sstF >= 68)                sp.push('Tuna - Offshore');
  if(sstF >= 70)                sp.push('Mahi-Mahi');
  if(sstF >= 68)                sp.push('Cobia');
  return sp;
}

// ── Fetch one zone ────────────────────────────────────────────
async function fetchZone(zone){
  try {
    const [wRes, mRes] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${zone.lat}&longitude=${zone.lon}&daily=windspeed_10m_max,windgusts_10m_max&wind_speed_unit=mph&forecast_days=3&timezone=America/New_York`),
      fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${zone.lat}&longitude=${zone.lon}&daily=wave_height_max,sea_surface_temperature_mean&length_unit=imperial&forecast_days=3&timezone=America/New_York`)
    ]);
    const w = await wRes.json();
    const m = await mRes.json();

    const wind  = Math.round(w.daily?.windspeed_10m_max?.[0]  || 0);
    const waveH = parseFloat(m2ft(m.daily?.wave_height_max?.[0] || 0).toFixed(1));
    const sstF  = parseFloat(c2f(m.daily?.sea_surface_temperature_mean?.[0] || 18).toFixed(1));
    const score = scoreZone(wind, waveH, sstF, zone.type === 'canyon');

    return { name: zone.name, type: zone.type, score, verdict: verdict(score), wind, waveH, sstF };
  } catch(e) {
    return { name: zone.name, type: zone.type, score: 50, verdict: 'BORDERLINE', wind: 0, waveH: 0, sstF: 60, error: true };
  }
}

// ── Generate the weekly report ────────────────────────────────
async function generateReport(env){
  const zones     = await Promise.all(ZONES.map(fetchZone));
  const inshore   = zones.filter(z => z.type !== 'canyon');
  const canyon    = zones.find(z  => z.type === 'canyon');
  const avgSST    = parseFloat((zones.reduce((s,z) => s + z.sstF, 0) / zones.length).toFixed(1));
  const avgScore  = Math.round(inshore.reduce((s,z) => s + z.score, 0) / inshore.length);
  const bestZone  = inshore.reduce((a,b) => a.score > b.score ? a : b);
  const worstZone = inshore.reduce((a,b) => a.score < b.score ? a : b);
  const species   = activeSpecies(avgSST);

  const now         = new Date();
  const dateKey     = now.toISOString().slice(0,10);
  const dateLong    = now.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const weekLabel   = `Week of ${now.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' })}`;

  // ── Build data summary for Claude ──
  const dataSummary = `
REPORT DATE: ${dateLong}

NJ ZONE SCORES:
${zones.map(z => `  ${z.name.padEnd(18)} Score: ${String(z.score).padStart(3)}/100  ${z.verdict.padEnd(12)}  Wind: ${z.wind}mph  Waves: ${z.waveH}ft  SST: ${z.sstF}°F`).join('\n')}

SUMMARY:
  Average inshore score: ${avgScore}/100
  Overall verdict: ${verdict(avgScore)}
  Best zone:  ${bestZone.name} (${bestZone.score}/100)
  Worst zone: ${worstZone.name} (${worstZone.score}/100)
  Canyon (Hudson): ${canyon ? `${canyon.score}/100 — ${canyon.verdict} | Wind ${canyon.wind}mph | Seas ${canyon.waveH}ft` : 'N/A'}
  Avg water temp: ${avgSST}°F
  Species in optimal temp range: ${species.length ? species.join(', ') : 'None currently'}
`.trim();

  // ── Call Claude API ──
  let narrative = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 700,
        system: `You are an expert NJ saltwater fishing guide writing the weekly conditions report for NJShoreReport.com — a free fishing conditions tool built by a local NJ angler.

Write a practical, knowledgeable weekly summary in a friendly but authoritative tone, like a seasoned captain giving a Friday morning briefing to his crew before the weekend trip. 

Guidelines:
- 3 to 4 paragraphs, 220 to 300 words total
- Plain prose — no bullet points, no headers, no markdown
- Use the actual data provided — specific zone names, temperatures, scores
- Mention which species are currently active and why
- Give weekend fishing advice based on the conditions
- If canyon conditions are good, mention the offshore opportunity
- If conditions are poor, suggest the best alternatives
- Vary your opening line — never start with "This week"
- Write for NJ fishermen who know the waters`,
        messages: [{ role: 'user', content: `Write this week's NJ fishing report using this data:\n\n${dataSummary}` }]
      })
    });
    const data = await res.json();
    narrative = data.content?.[0]?.text?.trim() || '';
  } catch(e) {
    // Fallback narrative if Claude API fails
    narrative = `Water temperatures along the NJ coast are sitting at ${avgSST}°F this week, putting ${species.slice(0,2).join(' and ')} in their active feeding range. Inshore conditions are averaging ${avgScore} out of 100 across all zones — a ${verdict(avgScore).toLowerCase()} outlook for the weekend.\n\n${bestZone.name} is the top zone this week with a score of ${bestZone.score}, while ${worstZone.name} is seeing the toughest conditions at ${worstZone.score}. ${canyon ? `Canyon runners should note ${canyon.name} is scoring ${canyon.score} with ${canyon.wind}mph winds and ${canyon.waveH}ft seas — ${canyon.verdict.toLowerCase()} for an offshore run.` : ''}\n\nCheck the full conditions tool for NOAA tide times, moon phase, and zone-specific species reports before heading out.`;
  }

  // ── Assemble report ──
  const report = {
    dateKey,
    dateFormatted: dateLong,
    weekLabel,
    narrative,
    zones,
    avgSST,
    avgScore,
    bestZone:      bestZone.name,
    bestScore:     bestZone.score,
    worstZone:     worstZone.name,
    worstScore:    worstZone.score,
    canyonVerdict: canyon?.verdict || 'BORDERLINE',
    canyonScore:   canyon?.score   || 50,
    activeSpecies: species,
  };

  // ── Store in KV ──
  await env.REPORTS.put(dateKey, JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 400 }); // ~13 months
  await env.REPORTS.put('latest', JSON.stringify(report));

  // Update index
  let index = [];
  try { index = JSON.parse(await env.REPORTS.get('index') || '[]'); } catch(e){}
  if(!index.includes(dateKey)){
    index.unshift(dateKey);
    index = index.slice(0, 52); // Keep 1 year
    await env.REPORTS.put('index', JSON.stringify(index));
  }

  return report;
}

// ── Worker entry point ────────────────────────────────────────
export default {

  // HTTP handler — serves stored reports to reports.html
  async fetch(request, env){
    const url  = new URL(request.url);
    const cors = {
      'Content-Type':               'application/json',
      'Access-Control-Allow-Origin':'*',
      'Cache-Control':              'public, max-age=1800'
    };

    // /latest — most recent report
    if(url.pathname === '/latest'){
      const data = await env.REPORTS.get('latest', 'json');
      return new Response(JSON.stringify(data), { headers: cors });
    }

    // /reports — last 12 weeks
    if(url.pathname === '/reports'){
      let index = [];
      try { index = JSON.parse(await env.REPORTS.get('index') || '[]'); } catch(e){}
      const reports = [];
      for(const key of index.slice(0, 12)){
        const r = await env.REPORTS.get(key, 'json');
        if(r) reports.push(r);
      }
      return new Response(JSON.stringify(reports), { headers: cors });
    }

    // /generate — manual trigger for testing
    if(url.pathname === '/generate'){
      const report = await generateReport(env);
      return new Response(JSON.stringify(report, null, 2), {
        headers: { ...cors, 'Cache-Control': 'no-store' }
      });
    }

    return new Response(JSON.stringify({
      status:    'Shore Report Weekly Generator',
      endpoints: ['/latest', '/reports', '/generate']
    }), { headers: cors });
  },

  // Cron trigger — runs every Friday at 11:00 UTC (7:00am ET)
  async scheduled(event, env, ctx){
    ctx.waitUntil(generateReport(env));
  }
};
