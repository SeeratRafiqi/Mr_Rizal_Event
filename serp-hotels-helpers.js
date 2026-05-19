/**
 * SerpAPI Google Hotels (via GET /api/hotels) — same-origin proxy as flights.
 * Loaded after serp-flights-helpers.js — exposes window.__serpHotelsHelpers.
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function mergeHotelProperties(data) {
    return Array.isArray(data.properties) ? data.properties : [];
  }

  function hotelPriceLabel(p) {
    if (p == null || typeof p !== 'object') return '—';
    const raw = p.price != null ? String(p.price).trim() : '';
    if (raw) return raw;
    const tr = p.total_rate;
    if (tr && tr.lowest) return String(tr.lowest);
    const rn = p.rate_per_night;
    if (rn && rn.lowest) return String(rn.lowest);
    if (p.extracted_price != null && Number.isFinite(Number(p.extracted_price))) {
      return 'MYR ' + Math.round(Number(p.extracted_price)).toLocaleString('en-MY');
    }
    return '—';
  }

  /**
   * Shape sent to POST /api/itinerary/generate and shown in hub summary.
   * @param {object} p Serp property row
   * @param {string} checkIn YYYY-MM-DD
   * @param {string} checkOut YYYY-MM-DD
   */
  function serializeForItinerary(p, checkIn, checkOut) {
    const name = String((p && p.name) || '').trim();
    const r = p && p.overall_rating != null && Number.isFinite(Number(p.overall_rating)) ? Number(p.overall_rating) : null;
    const rev = p && p.reviews != null && Number.isFinite(Number(p.reviews)) ? Math.round(Number(p.reviews)) : null;
    return {
      name: name,
      type: String((p && p.type) || '').trim(),
      overallRating: r,
      reviewsCount: rev,
      priceLabel: hotelPriceLabel(p),
      checkIn: String(checkIn || '').trim().slice(0, 10),
      checkOut: String(checkOut || '').trim().slice(0, 10),
      link: String((p && p.link) || '').trim(),
    };
  }

  function aiHotelInsight(p, idx) {
    const rating = Number(p && p.overall_rating);
    const reviews = Number(p && p.reviews);
    const priceRaw = String(hotelPriceLabel(p) || '');
    const extracted = Number(p && p.extracted_price);
    const type = String((p && p.type) || '').toLowerCase();
    if (idx === 0) {
      return {
        label: 'AI pick: venue-aware base',
        reason: 'Start here: this is the strongest live hotel result for the event-area search.',
      };
    }
    if (Number.isFinite(rating) && rating >= 4.5 && Number.isFinite(reviews) && reviews >= 100) {
      return {
        label: 'Best confidence stay',
        reason: 'High rating and review volume make this safer for international travellers.',
      };
    }
    if ((Number.isFinite(extracted) && extracted < 260) || /rm\s?1|rm\s?2|myr\s?1|myr\s?2/i.test(priceRaw)) {
      return {
        label: 'Best value',
        reason: 'Good candidate when you want more budget left for food, tickets and local experiences.',
      };
    }
    if (/hotel|resort|suite|serviced/.test(type) && Number.isFinite(rating) && rating >= 4) {
      return {
        label: 'Comfort traveller fit',
        reason: 'Better for travellers who want a smoother check-in, rest window and event-night return.',
      };
    }
    return {
      label: 'Alternative stay area',
      reason: 'Compare distance, late-night transport and cancellation policy before opening the provider.',
    };
  }

  /**
   * @param {Array<object>} rows
   * @param {string} googleHotelsUrl Same Google Hotels search URL for every row (like flights + google_flights_url).
   * @param {boolean} hubPick When true, append “Add to my itinerary” per row (event hub).
   * @returns {string}
   */
  function renderSerpHotelListItems(rows, googleHotelsUrl, hubPick) {
    const bookHref = escapeHtml(
      String(googleHotelsUrl || '').trim() || 'https://www.google.com/travel/hotels',
    );
    return rows
      .map(function (p, idx) {
        const insight = aiHotelInsight(p, idx);
        const name = escapeHtml(p.name || 'Property');
        const rating =
          p.overall_rating != null && Number.isFinite(Number(p.overall_rating))
            ? Number(p.overall_rating).toFixed(1)
            : '—';
        const reviews = p.reviews != null ? String(p.reviews) : '';
        const revStr = reviews ? escapeHtml(reviews) + ' reviews' : '';
        const price = escapeHtml(hotelPriceLabel(p));
        const src =
          (p.thumbnail && String(p.thumbnail).trim()) ||
          (p.images &&
            p.images[0] &&
            (String(p.images[0].thumbnail || '').trim() ||
              String(p.images[0].original_image || '').trim())) ||
          '';
        const logoBlock = src
          ? '<img class="eh-serp-logo eh-serp-logo--hotel" src="' +
            escapeHtml(src) +
            '" alt="" width="36" height="36" loading="lazy" decoding="async" />'
          : '<div class="eh-serp-logo eh-serp-logo--ph" aria-hidden="true"></div>';
        return (
          '<li class="eh-hotel-row eh-serp-row">' +
          '<div class="eh-serp-left">' +
          logoBlock +
          '<div class="eh-serp-mid">' +
          '<span class="eh-ai-rec">' +
          escapeHtml(insight.label) +
          '</span>' +
          '<div><strong>' +
          name +
          '</strong></div>' +
          (p.type ? '<span class="eh-flight-sub">' + escapeHtml(String(p.type)) + '</span>' : '') +
          '<span class="eh-flight-sub">Rating ' +
          escapeHtml(rating) +
          (revStr ? ' · ' + revStr : '') +
          '</span>' +
          '<span class="eh-ai-reason">' +
          escapeHtml(insight.reason) +
          '</span>' +
          '</div></div>' +
          '<div class="eh-flight-meta">' +
          '<span class="eh-price">' +
          price +
          '</span>' +
          (hubPick
            ? '<button type="button" class="eh-btn eh-btn--gold eh-serp-add-itin" data-eh-add-hotel="' +
              idx +
              '">Add to my itinerary</button>'
            : '') +
          '<a class="eh-btn eh-btn--ghost eh-serp-book" href="' +
          bookHref +
          '" target="_blank" rel="noopener noreferrer">Open provider</a>' +
          '</div></li>'
        );
      })
      .join('');
  }

  function hotelsBookUrlFromResponse(data) {
    return (
      (data.search_metadata && data.search_metadata.google_hotels_url) ||
      'https://www.google.com/travel/hotels'
    );
  }

  function fetchSerpHotels(params, signal) {
    const q = new URLSearchParams({
      q: String(params.q || '').trim(),
      check_in_date: String(params.checkIn || '').trim().slice(0, 10),
      check_out_date: String(params.checkOut || '').trim().slice(0, 10),
      adults: String(params.adults != null ? params.adults : 2),
    });
    return fetch('/api/hotels?' + q.toString(), { signal: signal }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error(String((data && (data.error || data.message))) || 'Hotel search failed');
        }
        return data;
      });
    });
  }

  global.__serpHotelsHelpers = {
    escapeHtml: escapeHtml,
    mergeHotelProperties: mergeHotelProperties,
    fetchSerpHotels: fetchSerpHotels,
    renderSerpHotelListItems: renderSerpHotelListItems,
    hotelsBookUrlFromResponse: hotelsBookUrlFromResponse,
    serializeForItinerary: serializeForItinerary,
  };
})(typeof window !== 'undefined' ? window : this);
