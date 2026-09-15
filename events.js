const EVENTS = [
  {
    id: 'demo-boston-2026-10-29',
    name: 'Demo Headliner',
    eventName: 'Stand Up Seeker API test show',
    venue: 'Demo Theatre',
    city: 'Boston',
    state: 'MA',
    date: '2026-10-29',
    time: '8:00 PM',
    tier: 'Major headliner',
    ticketUrl: '',
    ticketProvider: 'Official source',
    imageUrl: '',
    imageRights: 'none',
    verifiedAt: '2026-09-15T00:00:00Z',
    verifiedBy: ['demo seed'],
    isDemo: true
  }
];

function parseDate(s) {
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  const cityRaw = String(req.query.city || '').trim();
  const city = cityRaw.toLowerCase();
  const date = String(req.query.date || '').trim();
  const windowDays = Math.max(0, Math.min(7, Number(req.query.window || 0)));
  if (!city || !date) return res.status(400).json({ error: 'city and date are required' });
  const target = parseDate(date);
  if (!target) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const ms = windowDays * 86400000;
  const matches = EVENTS.filter((event) => {
    const eventDate = parseDate(event.date);
    return eventDate && event.city.toLowerCase() === city && Math.abs(eventDate - target) <= ms;
  });
  return res.status(200).json({
    events: matches,
    meta: { city: cityRaw, date, window: windowDays, count: matches.length, mode: 'api-test', generatedAt: new Date().toISOString() }
  });
};
