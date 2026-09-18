module.exports = async function handler(req, res) {
  try {
    const city = String(req.query.city || "").trim();
    const date = String(req.query.date || "").trim();
    const comedian = String(req.query.comedian || "").trim();
    const windowDays = Math.max(
      0,
      Math.min(7, Number(req.query.window || 0))
    );

    if (!comedian && (!city || !date)) {
      return res.status(400).json({
        error: "city and date are required unless searching by comedian"
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        error: "Supabase environment variables are missing"
      });
    }

    const effectiveDate = comedian ? new Date().toISOString().slice(0, 10) : date;
    const target = new Date(`${effectiveDate}T12:00:00Z`);

    if (Number.isNaN(target.getTime())) {
      return res.status(400).json({
        error: "date must be YYYY-MM-DD"
      });
    }

    const start = new Date(target);
    if (!comedian) start.setUTCDate(start.getUTCDate() - windowDays);

    const end = new Date(target);
    if (!comedian) end.setUTCDate(end.getUTCDate() + windowDays); else end.setUTCFullYear(end.getUTCFullYear() + 2);

    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    const params = new URLSearchParams({
      select:
        "id,event_name,starts_at,local_date,local_time,city,state_region,country,official_ticket_url,ticket_provider,status,verification_status,verification_reason,confidence_score,source_count,last_verified_at,comedians(name,tier,image_url,image_rights),venues(name,official_url)",
      publishable: "eq.true",
      verification_status: "in.(verified,verified_2_source)",
      local_date: `gte.${startDate}`,
      order: "starts_at.asc"
    });

    params.append("local_date", `lte.${endDate}`);
    if (city && !comedian) params.set("city", `ilike.${city}`);
    if (comedian) { params.set("comedians", `not.is.null`); params.set("comedians.name", `ilike.${comedian}`); }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/shows?${params.toString()}`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    );

    if (!response.ok) {
      const details = await response.text();

      return res.status(500).json({
        error: "Supabase query failed",
        details
      });
    }

    const rows = await response.json();

    const events = rows.map((row) => ({
      id: row.id,
      name: row.comedians?.name || "",
      eventName: row.event_name || row.comedians?.name || "",
      venue: row.venues?.name || "",
      city: row.city,
      state: row.state_region || "",
      country: row.country,
      date: row.local_date,
      time: row.local_time || "",
      tier: row.comedians?.tier || "",
      ticketUrl: row.official_ticket_url || "",
      ticketProvider: row.ticket_provider || "Official source",
      imageUrl: row.comedians?.image_url || "",
      verifiedAt: row.last_verified_at,
      verificationStatus: row.verification_status,
      verificationReason: row.verification_reason || "",
      confidenceScore: row.confidence_score || 0,
      sourceCount: row.source_count || 0,
      imageRights: row.comedians?.image_rights || "none",
      status: row.status
    }));

    res.setHeader(
      "Cache-Control",
      "s-maxage=300, stale-while-revalidate=600"
    );

    return res.status(200).json({
      events,
      meta: {
        city,
        comedian,
        date: comedian ? null : date,
        window: comedian ? null : windowDays,
        count: events.length,
        mode: "supabase-live",
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Stand Up Seeker API failed",
      details: error.message
    });
  }
};
