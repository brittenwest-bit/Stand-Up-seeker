const fs = require('fs');
const path = require('path');

function parseDate(s) {
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  const city = String(req.query.city || '').trim().toLowerCase();
  const date = String(req.query.date || '').trim();
  const windowDays = Math.max(0, Math.min(7, Number(req.query.window || 0)));

  if (!city || !date) {
    return res.status(400).json({ error: 'city and date are required' });
  }
  const target = parseDate(date);
  if (!target) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const file = path.join(process.cwd(), 'data', 'events.json');
  const events = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ms = windowDays * 86400000;

  const matches = events.filter((event) => {
    const eventDate = parseDate(event.date);
    if (!eventDate) return false;
    const cityMatch = String(event.city || '').toLowerCase() === city;
    return cityMatch && Math.abs(eventDate.getTime() - target.getTime()) <= ms;
  }).sort((a,b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  const publicEvents = matches.map(e => ({
    id: e.id,
    name: e.comedian,
    eventName: e.tour || 'Live stand-up',
    venue: e.venue, city: e.city, state: e.state,
    date: e.date, time: e.time, tier: e.tier,
    ticketUrl: e.ticketUrl || '', ticketProvider: e.ticketProvider || '',
    imageUrl: e.imageUrl || '', imageRights: e.imageRights || 'none',
    verifiedAt: e.verifiedAt || null,
    verifiedBy: (e.sources || []).map(s => s.type || s.name).filter(Boolean),
    isDemo: Boolean(e.isDemo)
  }));

  return res.status(200).json({
    events: publicEvents,
    meta: {
      city: req.query.city,
      date,
      window: windowDays,
      count: matches.length,
      generatedAt: new Date().toISOString(),
      mode: 'seed-data'
    }
  });
};
