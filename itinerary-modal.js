/* Trip Planner UI — standalone from chatbot (viewer.html). */
(function () {
  'use strict';

  const DAY_ORDINALS = [
    'One','Two','Three','Four','Five','Six','Seven',
    'Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen',
  ];

  let selectedEvent = null;
  /** Full API envelope (multi-variant trips). */
  let tripEnvelope = null;
  let chosenVariantIdx = 0;
  /** Once false, picker hidden and plan detail visible */
  let planDetailVisible = false;
  let lastPayload = null;
  let lastAcEvents = [];
  let acTimer = null;

  /** Stashed planner UI when opening History — restored by Back. */
  let stashBeforeHistory = null;
  let itinHistoryVisible = false;

  function $(id) {
    return document.getElementById(id);
  }

  function getActiveVariant() {
    if (
      !tripEnvelope ||
      !Array.isArray(tripEnvelope.variants) ||
      !tripEnvelope.variants[chosenVariantIdx]
    )
      return null;
    return tripEnvelope.variants[chosenVariantIdx];
  }

  function normalizeTripEnvelope(raw) {
    if (raw && raw.schemaVersion === 2 && Array.isArray(raw.variants) && raw.variants.length) {
      return Object.assign({}, raw, {
        warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      });
    }
    return {
      schemaVersion: 2,
      event: raw.event,
      city: raw.city,
      warnings: raw.warnings || [],
      variants: [
        {
          key: 'classic',
          title: 'Your itinerary',
          tagline: 'Generated route',
          guideSummary: raw.guideSummary || '',
          warnings: [],
          days: raw.days || [],
          places: raw.places || [],
          travelLinks: raw.travelLinks || {},
        },
      ],
    };
  }

  function mergeEnvelopeWarnings(extra) {
    const top = (tripEnvelope && tripEnvelope.warnings) || [];
    const v = Array.isArray(extra) ? extra : [];
    return top.concat(v);
  }

  /**
   * Place overlay expects `lastPayload.event`, `places`, `city`.
   */
  function syncOverlayPayload(active) {
    if (!tripEnvelope || !active) {
      lastPayload = null;
      return;
    }
    lastPayload = {
      event: tripEnvelope.event,
      city: tripEnvelope.city,
      places: active.places || [],
    };
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toIsoDate(d) {
    if (!d) return '';
    const s = String(d).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return x.toISOString().slice(0, 10);
  }

  function tripInclusiveDays(startIso, endIso) {
    if (!startIso || !endIso || endIso < startIso) return 0;
    const a = new Date(startIso + 'T12:00:00Z');
    const b = new Date(endIso + 'T12:00:00Z');
    return Math.round((b - a) / 86400000) + 1;
  }

  function todayMalaysiaISO() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
  }

  function refreshHeaderBack() {
    const btn = $('itin-back-btn');
    if (!btn) return;
    const resSec = $('itin-result-section');
    const resVis = resSec && !resSec.hidden;
    const show = itinHistoryVisible || resVis;
    btn.hidden = !show;
    btn.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function formatHistoryDateLabel(iso) {
    if (!iso) return '';
    const s = String(iso).trim().slice(0, 10);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(iso);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function normalizeSavedEvent(ev, fallbackCity) {
    if (!ev || typeof ev !== 'object') return null;
    return {
      id: ev.id != null ? ev.id : '',
      title: ev.title || 'Event',
      date: ev.date || '',
      city: String(ev.city || fallbackCity || '').trim(),
      url: String(ev.url || '').trim(),
    };
  }

  /** When leaving History by Back, optionally restore planner state captured at open time. */
  function hideHistoryPanel(restoreFromStash) {
    const hs = $('itin-history-section');
    if (hs) {
      hs.hidden = true;
    }
    itinHistoryVisible = false;
    const s = stashBeforeHistory;
    if (restoreFromStash && s) {
      const formSec = $('itin-form-section');
      const resSec = $('itin-result-section');
      if (formSec) formSec.hidden = s.formHidden;
      if (resSec) resSec.hidden = s.resultsHidden;
      tripEnvelope = s.envelope;
      chosenVariantIdx = s.chosenVariantIdx;
      planDetailVisible = s.planDetailVisible;
      stashBeforeHistory = null;
      if (!s.resultsHidden && tripEnvelope) {
        if (planDetailVisible) {
          renderChosenPlan();
        } else {
          hidePlanSkeleton();
          renderVariantStage();
          renderToolbar();
        }
      }
    } else if (!restoreFromStash) {
      stashBeforeHistory = null;
    }
    refreshHeaderBack();
  }

  function openHistoryPanel() {
    stashBeforeHistory = {
      formHidden: $('itin-form-section') ? $('itin-form-section').hidden : false,
      resultsHidden: $('itin-result-section') ? $('itin-result-section').hidden : true,
      envelope: tripEnvelope ? JSON.parse(JSON.stringify(tripEnvelope)) : null,
      chosenVariantIdx,
      planDetailVisible,
    };
    itinHistoryVisible = true;
    const formSec = $('itin-form-section');
    const resSec = $('itin-result-section');
    if (formSec) formSec.hidden = true;
    if (resSec) resSec.hidden = true;
    const hs = $('itin-history-section');
    if (hs) hs.hidden = false;
    fetchHistoryList();
    refreshHeaderBack();
  }

  function fetchHistoryList() {
    const st = $('itin-history-status');
    const empty = $('itin-history-empty');
    const ul = $('itin-history-ul');
    if (st) {
      st.hidden = false;
      st.removeAttribute('hidden');
    }
    if (empty) empty.hidden = true;
    if (ul) {
      ul.innerHTML = '';
      ul.hidden = true;
    }
    fetch('/api/itinerary/history?limit=30')
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (data) {
        if (st) {
          st.hidden = true;
          st.setAttribute('hidden', '');
        }
        const items = Array.isArray(data.items) ? data.items : [];
        if (data.error && !items.length) {
          showAlert(String(data.error));
        }
        if (!items.length) {
          if (empty) {
            empty.hidden = false;
            empty.removeAttribute('hidden');
          }
          return;
        }
        if (empty) empty.hidden = true;
        if (ul) {
          ul.hidden = false;
          ul.removeAttribute('hidden');
          ul.innerHTML = items
            .map(function (it) {
              const title = escapeHtml(it.eventTitle || 'Saved trip');
              const city = escapeHtml(String(it.city || '').trim());
              const created = formatHistoryDateLabel(it.createdAt);
              const range =
                it.arrivalDate && it.departureDate
                  ? formatHistoryDateLabel(it.arrivalDate) + ' – ' + formatHistoryDateLabel(it.departureDate)
                  : '';
              const nVar = Number(it.variantsCount) || 1;
              const meta =
                [city, range, created ? 'Saved ' + created : '', nVar > 1 ? nVar + ' journeys' : ''].filter(Boolean)
                  .join(' · ') || '';
              return (
                '<li><button type="button" class="itin-history-row" data-history-id="' +
                escapeHtml(String(it.id)) +
                '">' +
                '<span class="itin-history-row-title">' +
                title +
                '</span><span class="itin-history-row-meta">' +
                escapeHtml(meta) +
                '</span></button></li>'
              );
            })
            .join('');
        }
      })
      .catch(function () {
        if (st) {
          st.hidden = true;
          st.setAttribute('hidden', '');
        }
        showAlert('Could not load planner history.');
        if (empty) {
          empty.hidden = false;
          empty.removeAttribute('hidden');
        }
      });
  }

  async function loadSavedItinerary(id) {
    const sid = String(id || '').trim();
    if (!sid) return;
    clearAlert();
    showLoadingMsg('Loading saved itinerary…');
    stashBeforeHistory = null;
    itinHistoryVisible = false;
    const hs = $('itin-history-section');
    if (hs) hs.hidden = true;
    try {
      const res = await fetch('/api/itinerary/saved/' + encodeURIComponent(sid));
      const row = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showAlert(row.error || 'Could not open this saved trip.');
        return;
      }
      const depEl = $('itin-date-depart');
      const retEl = $('itin-date-return');
      if (depEl && row.arrival_date) depEl.value = String(row.arrival_date).slice(0, 10);
      if (retEl && row.departure_date) retEl.value = String(row.departure_date).slice(0, 10);
      const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const evNorm = normalizeSavedEvent(p.event, row.city || p.city);
      if (evNorm) setSelectedEvent(evNorm);
      const formSec = $('itin-form-section');
      const resSec = $('itin-result-section');
      if (formSec) formSec.hidden = true;
      if (resSec) resSec.hidden = false;
      const vPref =
        typeof p.selectedVariantIndex === 'number' && Number.isFinite(p.selectedVariantIndex)
          ? p.selectedVariantIndex
          : 0;
      renderResults(p, {
        skipPicker: true,
        variantIndex: vPref,
      });
    } catch (e) {
      showAlert('Could not reach the server.');
    } finally {
      hideLoadingMsg();
      refreshHeaderBack();
    }
  }

  function performTripBack() {
    clearAlert();
    if (itinHistoryVisible) {
      hideHistoryPanel(true);
      return;
    }
    if (!tripEnvelope) return;
    if (planDetailVisible && tripEnvelope.variants.length > 1) {
      planDetailVisible = false;
      hidePlanSkeleton();
      renderVariantStage();
      renderToolbar();
      refreshHeaderBack();
      return;
    }
    resetToForm();
  }

  function showAlert(msg) {
    const el = $('itin-alert');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    if (msg) el.classList.add('itin-alert--visible');
    else el.classList.remove('itin-alert--visible');
  }

  function clearAlert() {
    showAlert('');
  }

  function showLoadingMsg(text) {
    const el = $('itin-loading-msg');
    if (!el) return;
    el.textContent =
      text ||
      'Generating your itinerary — calling the AI and loading place photos. Usually 30–90 seconds; long trips can take up to 3 minutes.';
    el.removeAttribute('hidden');
    el.hidden = false;
  }

  function hideLoadingMsg() {
    const el = $('itin-loading-msg');
    if (!el) return;
    el.hidden = true;
    el.setAttribute('hidden', '');
  }

  function openTripModal() {
    const m = $('itin-modal');
    if (!m) return;
    m.classList.add('is-open');
    m.setAttribute('aria-hidden', 'false');
    document.body.classList.add('itin-modal-open');
    refreshHeaderBack();
  }

  function closeTripModal() {
    const m = $('itin-modal');
    if (!m) return;
    if (itinHistoryVisible) {
      hideHistoryPanel(true);
    } else {
      stashBeforeHistory = null;
    }
    const hs = $('itin-history-section');
    if (hs) hs.hidden = true;
    m.classList.remove('is-open');
    m.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('itin-modal-open');
    closePlaceOverlay();
    refreshHeaderBack();
  }

  function closePlaceOverlay() {
    const o = $('itin-place-overlay');
    if (!o) return;
    o.classList.remove('is-open');
    o.setAttribute('aria-hidden', 'true');
  }

  function openPlaceOverlay(placeId) {
    if (!lastPayload || !Array.isArray(lastPayload.places)) return;
    const p = lastPayload.places.find(function (x) {
      return String(x.id) === String(placeId);
    });
    if (!p) return;
    const img = $('itin-place-img');
    const title = $('itin-place-title');
    const loc = $('itin-place-loc');
    const desc = $('itin-place-desc');
    const fact = $('itin-place-fact');
    const meta = $('itin-place-meta');
    const mapBtn = $('itin-place-map');
    if (img) {
      img.src = p.image || '';
      img.alt = p.name || '';
      img.onerror = function () {
        img.src =
          'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&w=800&q=70';
      };
    }
    if (title) title.textContent = p.name || 'Place';
    if (loc) loc.textContent = p.location || lastPayload.city || '';
    if (desc) desc.textContent = p.description || '';
    if (fact) fact.textContent = p.funFact || '—';
    if (meta) {
      var live = p.liveStatus ? '<span><strong>Status</strong> ' + escapeHtml(p.liveStatus) + '</span>' : '';
      meta.innerHTML =
        live +
        '<span><strong>Duration</strong> ' +
        escapeHtml(p.duration || '—') +
        '</span><span><strong>Cost</strong> ' +
        escapeHtml(p.cost || '—') +
        '</span>';
    }
    if (mapBtn) {
      mapBtn.href = p.mapUrl || '#';
      mapBtn.target = '_blank';
      mapBtn.rel = 'noopener noreferrer';
    }
    const o = $('itin-place-overlay');
    if (o) {
      o.classList.add('is-open');
      o.setAttribute('aria-hidden', 'false');
    }
  }

  function getCheckedInterests() {
    const boxes = document.querySelectorAll('.itin-interest:checked');
    return Array.prototype.map.call(boxes, function (b) {
      return b.value;
    });
  }

  function validateBeforeSubmit() {
    clearAlert();
    const dep = $('itin-date-depart') && $('itin-date-depart').value;
    const ret = $('itin-date-return') && $('itin-date-return').value;
    const today = todayMalaysiaISO();
    if (!selectedEvent) {
      showAlert('Please select an event');
      return false;
    }
    if (!dep || !ret) {
      showAlert('Please choose trip start and return dates');
      return false;
    }
    if (dep < today || ret < today) {
      showAlert('Departure and return dates must be today or later');
      return false;
    }
    if (ret < dep) {
      showAlert('Return date must be after departure date');
      return false;
    }
    const len = tripInclusiveDays(dep, ret);
    if (len > 14) {
      showAlert('Trip length is capped at 14 days');
      return false;
    }
    const evIso = toIsoDate(selectedEvent.date);
    if (evIso && (evIso < dep || evIso > ret)) {
      showAlert(
        'Event is on ' +
          evIso +
          ', but your trip is ' +
          dep +
          ' to ' +
          ret +
          '. Update your dates so the event falls within your trip.',
      );
      return false;
    }
    return true;
  }

  function renderAutocomplete(events) {
    const list = $('itin-ac-list');
    if (!list) return;
    lastAcEvents = Array.isArray(events) ? events.slice() : [];
    if (!lastAcEvents.length) {
      list.innerHTML = '';
      list.hidden = true;
      return;
    }
    list.hidden = false;
    list.innerHTML = lastAcEvents
      .map(function (e) {
        const label = escapeHtml(e.title || 'Event');
        const when = escapeHtml(toIsoDate(e.date) || 'Date TBA');
        const city = escapeHtml(e.city || '');
        return (
          '<button type="button" class="itin-ac-item" data-id="' +
          escapeHtml(String(e.id)) +
          '">' +
          '<strong>' +
          label +
          '</strong><span>' +
          when +
          (city ? ' · ' + city : '') +
          '</span></button>'
        );
      })
      .join('');
  }

  function fetchAutocomplete(q) {
    const list = $('itin-ac-list');
    if (!q || q.length < 2) {
      if (list) {
        list.innerHTML = '';
        list.hidden = true;
      }
      return;
    }
    fetch('/api/itinerary/events?q=' + encodeURIComponent(q))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        renderAutocomplete(data.events || []);
      })
      .catch(function () {
        renderAutocomplete([]);
      });
  }

  function setSelectedEvent(ev) {
    selectedEvent = ev;
    const hid = $('itin-event-id');
    const label = $('itin-selected-label');
    if (hid) hid.value = ev && ev.id != null ? String(ev.id) : '';
    if (label) {
      if (!ev) label.textContent = 'No event selected';
      else {
        label.textContent =
          (ev.title || 'Event') + ' · ' + (toIsoDate(ev.date) || '?');
      }
    }
    const ac = $('itin-ac-list');
    if (ac) {
      ac.innerHTML = '';
      ac.hidden = true;
    }
    const inp = $('itin-event-search');
    if (inp) inp.value = '';
  }

  function renderToolbar() {
    const tb = $('itin-plan-toolbar');
    if (!tb) return;
    if (!tripEnvelope || tripEnvelope.variants.length <= 1 || !planDetailVisible) {
      tb.innerHTML = '';
      tb.hidden = true;
      return;
    }
    tb.hidden = false;
    tb.innerHTML =
      '<span class="itin-plan-toolbar-label">Compare drafts</span>' +
      tripEnvelope.variants
        .map(function (v, i) {
          var active = i === chosenVariantIdx ? ' is-active' : '';
          return (
            '<button type="button" class="itin-plan-tab' +
            active +
            '" data-switch-variant="' +
            i +
            '">' +
            escapeHtml(v.title || 'Plan ' + (i + 1)) +
            '</button>'
          );
        })
        .join('');
  }

  function renderVariantStage() {
    const st = $('itin-variant-stage');
    if (!st) return;
    if (
      planDetailVisible ||
      !tripEnvelope ||
      !Array.isArray(tripEnvelope.variants) ||
      tripEnvelope.variants.length <= 1
    ) {
      st.hidden = true;
      st.innerHTML = '';
      return;
    }
    st.hidden = false;
    var vs = tripEnvelope.variants;
    var cards = vs
      .map(function (v, i) {
        var blurbSource = String(v.guideSummary || '').replace(/\s+/g, ' ').trim().slice(0, 420);
        var nPlaces = Array.isArray(v.places) ? v.places.length : 0;
        var nDays = Array.isArray(v.days) ? v.days.length : 0;
        return (
          '<button type="button" class="itin-variant-card" data-pick-variant="' +
          i +
          '">' +
          '<span class="itin-variant-card-num">Curated journey ' +
          String(i + 1) +
          ' / ' +
          vs.length +
          '</span>' +
          '<h3>' +
          escapeHtml(v.title || 'Route ' + (i + 1)) +
          '</h3>' +
          (v.tagline
            ? '<p class="itin-variant-tagline">' + escapeHtml(v.tagline) + '</p>'
            : '') +
          '<p class="itin-variant-blurb">' +
          escapeHtml(blurbSource) +
          '</p>' +
          '<span class="itin-meta-inline" style="font-size:11px;color:#887b6f;margin-bottom:12px;display:block;">' +
          nDays +
          ' days · ' +
          nPlaces +
          ' stops</span>' +
          '<span class="itin-variant-select-pill">Select this journey&nbsp;→</span>' +
          '</button>'
        );
      })
      .join('');
    st.innerHTML =
      '<p class="itin-variant-stage-intro">Three curator journeys</p>' +
      '<p class="itin-variant-stage-meta">Each route honours the same calendar with a distinct point of view. Choose the storyline that resonates; you may refresh any single day—or save when it feels locked in.</p>' +
      '<div class="itin-variant-grid">' +
      cards +
      '</div>';
  }

  function hidePlanSkeleton() {
    var g = $('itin-guide-summary');
    if (g) {
      g.textContent = '';
      g.hidden = true;
      g.setAttribute('hidden', '');
    }
    var sw = $('itin-summary-row-wrap');
    if (sw) {
      sw.hidden = true;
      sw.setAttribute('hidden', '');
    }
    var w = $('itin-warnings');
    if (w) {
      w.innerHTML = '';
      w.hidden = true;
      w.setAttribute('hidden', '');
    }
    var pa = $('itin-plan-actions');
    if (pa) {
      pa.hidden = true;
      pa.setAttribute('hidden', '');
    }
    var daysHost = $('itin-days-container');
    if (daysHost) daysHost.innerHTML = '';
    var tl = $('itin-travel-links');
    if (tl) tl.innerHTML = '';
  }

  function renderChosenPlan() {
    if (!tripEnvelope) return;
    var act = getActiveVariant();
    if (!act) return;
    syncOverlayPayload(act);
    planDetailVisible = true;
    var g = $('itin-guide-summary');
    if (g) {
      g.textContent = act.guideSummary || '';
      g.hidden = false;
      g.removeAttribute('hidden');
    }
    renderSummary({
      days: act.days,
      places: act.places,
      event: tripEnvelope.event,
    });
    renderWarnings(mergeEnvelopeWarnings(act.warnings));
    var sw = $('itin-summary-row-wrap');
    if (sw) {
      sw.hidden = false;
      sw.removeAttribute('hidden');
    }
    var pa = $('itin-plan-actions');
    if (pa) {
      pa.hidden = false;
      pa.removeAttribute('hidden');
    }
    renderTravelLinks(act.travelLinks || {});
    renderDays(act, true);
    renderToolbar();
    renderVariantStage();
  }

  function renderSummary(payload) {
    const days = Array.isArray(payload.days) ? payload.days.length : 0;
    const nPlaces = Array.isArray(payload.places) ? payload.places.length : 0;
    const mainD = payload.event && toIsoDate(payload.event.date);
    const dEl = $('itin-summary-duration');
    const pEl = $('itin-summary-places');
    const eEl = $('itin-summary-eventdate');
    if (dEl) dEl.textContent = days ? String(days) + (days === 1 ? ' day' : ' days') : '—';
    if (pEl) pEl.textContent = String(nPlaces);
    if (eEl) eEl.textContent = mainD || '—';
  }

  function miniCardHtml(slot) {
    const pid = escapeHtml(slot.id);
    const name = escapeHtml(slot.name);
    const area = escapeHtml(slot.area || '');
    const img = escapeHtml(slot.image || '');
    return (
      '<button type="button" class="itin-mini-card" data-place-id="' +
      pid +
      '">' +
      '<div class="itin-mini-img-wrap">' +
      (img
        ? '<img src="' + img + '" alt="" loading="lazy" />'
        : '<div class="itin-mini-fallback">📍</div>') +
      '</div><div class="itin-mini-body"><strong>' +
      name +
      '</strong><span>' +
      area +
      '</span></div></button>'
    );
  }

  function slotSection(title, slots) {
    const arr = Array.isArray(slots) ? slots : [];
    if (!arr.length) return '';
    return (
      '<div class="itin-slot">' +
      '<div class="itin-slot-label"><span class="itin-slot-dot"></span>' +
      escapeHtml(title) +
      '</div><div class="itin-mini-grid">' +
      arr.map(miniCardHtml).join('') +
      '</div></div>'
    );
  }

  function renderDays(payload, showDayRegenerate) {
    const host = $('itin-days-container');
    if (!host) return;
    const days = payload.days || [];
    host.innerHTML = days
      .map(function (day, idx) {
        const numStr = String(idx + 1).padStart(2, '0');
        const ordinal = DAY_ORDINALS[idx] || String(idx + 1);

        const meals = Array.isArray(day.meals)
          ? day.meals.map(function (m) {
              return (
                '<li><strong>' + escapeHtml(m.time || '') + '</strong> ' +
                escapeHtml(m.type || '') + ' — ' + escapeHtml(m.suggestion || '') +
                (m.dish ? ' &middot; ' + escapeHtml(m.dish) : '') + '</li>'
              );
            }).join('')
          : '';
        const tips = Array.isArray(day.tips)
          ? day.tips.map(function (t) {
              return '<li>' + escapeHtml(t) + '</li>';
            }).join('')
          : '';

        const noteHtml = (meals || tips)
          ? '<div class="itin-day-note">' +
            (meals ? '<div class="itin-meals"><h4>Meals</h4><ul>' + meals + '</ul></div>' : '') +
            (tips  ? '<div class="itin-tips"><h4>Tips</h4><ul>'  + tips  + '</ul></div>' : '') +
            '</div>'
          : '';

        const hasMorning   = Array.isArray(day.morning) && day.morning.length;
        const hasAfternoon = Array.isArray(day.afternoon) && day.afternoon.length;
        const hasEvening   = Array.isArray(day.evening) && day.evening.length;
        const hasSlots     = hasMorning || hasAfternoon || hasEvening;

        const slotsHtml = hasSlots
          ? '<div class="itin-slots-row">' +
            slotSection('Morning', day.morning) +
            slotSection('Afternoon', day.afternoon) +
            slotSection('Evening', day.evening) +
            '</div>'
          : '';

        const regenHtml =
          showDayRegenerate && planDetailVisible
            ? '<div class="itin-day-actions">' +
              '<button type="button" class="itin-day-regen" data-regen-day="' +
              idx +
              '">Redraft this day</button>' +
              '</div>'
            : '';

        return (
          '<article class="itin-day-card" data-day-card="' +
          idx +
          '">' +
          '<div class="itin-day-spine">' +
          '<span class="itin-day-num">' +
          numStr +
          '</span>' +
          '<span class="itin-day-spine-lbl">Day ' +
          escapeHtml(ordinal) +
          '</span>' +
          '<div class="itin-day-line"></div>' +
          '</div>' +
          '<div class="itin-day-content">' +
          '<div class="itin-day-hdr">' +
          '<h3 class="itin-day-dest">' +
          escapeHtml(day.label || 'Day ' + (idx + 1)) +
          '</h3>' +
          (day.subtitle ? '<p class="itin-day-tagline">' + escapeHtml(day.subtitle) + '</p>' : '') +
          '</div>' +
          regenHtml +
          slotsHtml +
          noteHtml +
          '</div>' +
          '</article>'
        );
      })
      .join('');
  }

  function renderWarnings(warnings) {
    const w = $('itin-warnings');
    if (!w) return;
    if (!warnings || !warnings.length) {
      w.innerHTML = '';
      w.hidden = true;
      w.setAttribute('hidden', '');
      return;
    }
    w.removeAttribute('hidden');
    w.hidden = false;
    w.innerHTML = warnings
      .map(function (x) {
        const sev = x.severity === 'warn' ? 'itin-warn--warn' : 'itin-warn--info';
        return (
          '<div class="itin-warn ' +
          sev +
          '">' +
          escapeHtml(x.message || '') +
          '</div>'
        );
      })
      .join('');
  }

  function renderTravelLinks(links) {
    const host = $('itin-travel-links');
    if (!host) return;
    if (!links || typeof links !== 'object') {
      host.innerHTML = '';
      return;
    }
    const f = links.flights || '#';
    const h = links.hotels || '#';

    /** Stash event venue/city + trip dates on the Hotel button so the modal opens pre-filled near the event. */
    const ev = (lastPayload && lastPayload.event) || {};
    const venue = String(ev.venue || '').trim();
    const city = String(ev.city || (lastPayload && lastPayload.city) || '').trim();
    const dep = ($('itin-date-depart') && $('itin-date-depart').value) || '';
    const ret = ($('itin-date-return') && $('itin-date-return').value) || '';

    host.innerHTML =
      '<h4>Travel links</h4><div class="itin-links-row">' +
      '<button type="button" class="itin-link-btn" id="itin-flight-search-open">Flight search</button>' +
      '<button type="button" class="itin-link-btn itin-link-btn--alt" id="itin-hotel-search-open"' +
      ' data-event-venue="' +
      escapeHtml(venue) +
      '" data-event-city="' +
      escapeHtml(city) +
      '" data-trip-depart="' +
      escapeHtml(dep) +
      '" data-trip-return="' +
      escapeHtml(ret) +
      '">Hotel search</button>' +
      '</div>';
  }

  function renderResults(raw, opts) {
    opts = opts || {};
    tripEnvelope = normalizeTripEnvelope(raw);
    const nVar = tripEnvelope.variants.length;
    var idx =
      typeof opts.variantIndex === 'number' && Number.isFinite(opts.variantIndex)
        ? Math.floor(opts.variantIndex)
        : 0;
    chosenVariantIdx = nVar ? Math.max(0, Math.min(nVar - 1, idx)) : 0;
    planDetailVisible = opts.skipPicker === true ? true : nVar <= 1;
    const formSec = $('itin-form-section');
    const resSec = $('itin-result-section');
    if (formSec) formSec.hidden = true;
    if (resSec) resSec.hidden = false;

    if (planDetailVisible) {
      renderVariantStage();
      renderChosenPlan();
    } else {
      hidePlanSkeleton();
      renderVariantStage();
      renderToolbar();
    }
    refreshHeaderBack();
  }

  function resetToForm() {
    lastPayload = null;
    tripEnvelope = null;
    chosenVariantIdx = 0;
    planDetailVisible = false;
    stashBeforeHistory = null;
    itinHistoryVisible = false;
    const hs = $('itin-history-section');
    if (hs) hs.hidden = true;
    const ht = $('itin-history-status');
    if (ht) {
      ht.hidden = true;
      ht.setAttribute('hidden', '');
    }
    const he = $('itin-history-empty');
    if (he) he.hidden = true;
    const hul = $('itin-history-ul');
    if (hul) {
      hul.innerHTML = '';
      hul.hidden = true;
    }
    const st = $('itin-variant-stage');
    if (st) {
      st.innerHTML = '';
      st.hidden = true;
    }
    const tb = $('itin-plan-toolbar');
    if (tb) {
      tb.innerHTML = '';
      tb.hidden = true;
    }
    const pa = $('itin-plan-actions');
    if (pa) {
      pa.hidden = true;
    }
    const formSec = $('itin-form-section');
    const resSec = $('itin-result-section');
    if (formSec) formSec.hidden = false;
    if (resSec) resSec.hidden = true;
    hidePlanSkeleton();
    clearAlert();
    refreshHeaderBack();
  }

  async function onGenerate() {
    if (!validateBeforeSubmit()) return;
    const btn = $('itin-generate');
    const btnLabel = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Generating…';
    }
    clearAlert();
    showLoadingMsg(
      'Crafting three distinct curator itineraries and sourcing imagery — often 45–180 seconds total; lengthy trips run longer.',
    );
    const clientAbortMs = 280000;
    const ac = new AbortController();
    const abortTimer = setTimeout(function () {
      ac.abort();
    }, clientAbortMs);
    try {
      const body = {
        eventId: String(selectedEvent.id != null ? selectedEvent.id : ''),
        eventUrl: String(selectedEvent.url || '').trim(),
        arrivalDate: $('itin-date-depart').value,
        departureDate: $('itin-date-return').value,
        city: (selectedEvent.city || '').trim(),
        adventureLevel: $('itin-adventure').value,
        interests: getCheckedInterests(),
        travelPace: $('itin-pace').value,
      };
      const res = await fetch('/api/itinerary/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showAlert(data.error || 'Could not generate itinerary. Try again later.');
        return;
      }
      hideLoadingMsg();
      renderResults(data);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        showAlert(
          'Request took too long and was cancelled. Try a shorter trip (fewer days) or check the server log — the AI step may need a higher timeout in .env (DASHSCOPE_ITINERARY_TIMEOUT_MS).',
        );
      } else {
        showAlert('Could not reach the server or the request failed. Confirm the app is running at http://localhost:3040 and try again.');
      }
    } finally {
      clearTimeout(abortTimer);
      hideLoadingMsg();
      if (btn) {
        btn.disabled = false;
        btn.textContent = btnLabel || 'Curate three journeys';
      }
    }
  }

  async function regenerateDay(dayIdx) {
    if (!tripEnvelope || !planDetailVisible) return;
    const act = getActiveVariant();
    if (!selectedEvent || !act) {
      showAlert('Select an event and a journey first.');
      return;
    }
    const btns = document.querySelectorAll('[data-regen-day="' + dayIdx + '"]');
    btns.forEach(function (b) {
      b.disabled = true;
    });
    clearAlert();
    showLoadingMsg('Redrafting this day with fresh stops — usually 20–60 seconds…');
    try {
      const res = await fetch('/api/itinerary/regenerate-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: String(selectedEvent.id != null ? selectedEvent.id : ''),
          eventUrl: String(selectedEvent.url || '').trim(),
          arrivalDate: $('itin-date-depart').value,
          departureDate: $('itin-date-return').value,
          adventureLevel: $('itin-adventure').value,
          interests: getCheckedInterests(),
          travelPace: $('itin-pace').value,
          dayIndex: dayIdx,
          variant: act,
        }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showAlert(data.error || 'Could not refresh this day. Try again.');
        return;
      }
      tripEnvelope.variants[chosenVariantIdx] = data.variant;
      renderChosenPlan();
      showAlert('Day updated — refreshed stops below.');
      setTimeout(function () {
        clearAlert();
      }, 4500);
    } catch (e) {
      showAlert('Could not reach the server. Try again.');
    } finally {
      hideLoadingMsg();
      btns.forEach(function (b) {
        b.disabled = false;
      });
    }
  }

  async function saveItinerary() {
    if (!tripEnvelope || !planDetailVisible || !selectedEvent) {
      showAlert('Generate and open a journey before saving.');
      return;
    }
    const act = getActiveVariant();
    const saveBtn = $('itin-save-trip');
    var prev = '';
    if (saveBtn) {
      prev = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
    }
    clearAlert();
    try {
      const res = await fetch('/api/itinerary/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: String(selectedEvent.id != null ? selectedEvent.id : ''),
          arrivalDate: $('itin-date-depart').value,
          departureDate: $('itin-date-return').value,
          city: tripEnvelope.city || (selectedEvent.city || '').trim(),
          event: tripEnvelope.event,
          selectedVariantKey: act.key || '',
          selectedVariantIndex: chosenVariantIdx,
          variants: tripEnvelope.variants,
        }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) {
        showAlert(data.error || 'Could not save. Check Supabase itineraries_generated table.');
        return;
      }
      showAlert(data.message || 'Saved to planner history ✓');
    } catch (e) {
      showAlert('Could not reach the save endpoint.');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = prev || 'Save itinerary';
      }
    }
  }

  function init() {
    const fab = $('itin-fab');
    const modal = $('itin-modal');
    if (!fab || !modal) return;

    fab.addEventListener('click', function () {
      openTripModal();
    });
    const mClose = $('itin-modal-close');
    if (mClose) mClose.addEventListener('click', closeTripModal);
    const mBd = $('itin-modal-backdrop');
    if (mBd) mBd.addEventListener('click', closeTripModal);

    const pClose = $('itin-place-close');
    if (pClose) pClose.addEventListener('click', closePlaceOverlay);
    const pBd = $('itin-place-backdrop');
    if (pBd) pBd.addEventListener('click', closePlaceOverlay);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      const po = $('itin-place-overlay');
      if (po && po.classList.contains('is-open')) {
        closePlaceOverlay();
        return;
      }
      if (modal.classList.contains('is-open')) closeTripModal();
    });

    const search = $('itin-event-search');
    if (search) {
      search.addEventListener('input', function () {
        const q = search.value.trim();
        if (acTimer) clearTimeout(acTimer);
        acTimer = setTimeout(function () {
          fetchAutocomplete(q);
        }, 220);
      });
    }

    const depInput = $('itin-date-depart');
    const retInput = $('itin-date-return');
    const minDate = todayMalaysiaISO();
    if (depInput) depInput.min = minDate;
    if (retInput) retInput.min = minDate;
    if (depInput && retInput) {
      depInput.addEventListener('change', function () {
        const d = depInput.value || minDate;
        retInput.min = d < minDate ? minDate : d;
      });
    }

    const acList = $('itin-ac-list');
    if (acList) {
      acList.addEventListener('click', function (e) {
        const btn = e.target.closest('.itin-ac-item');
        if (!btn) return;
        const id = btn.getAttribute('data-id');
        const ev = lastAcEvents.find(function (x) {
          return String(x.id) === String(id);
        });
        if (ev) setSelectedEvent(ev);
      });
    }

    const gen = $('itin-generate');
    if (gen) gen.addEventListener('click', onGenerate);
    const edit = $('itin-edit-trip');
    if (edit) edit.addEventListener('click', resetToForm);

    const saveTrip = $('itin-save-trip');
    if (saveTrip) saveTrip.addEventListener('click', saveItinerary);

    const backBtn = $('itin-back-btn');
    if (backBtn) backBtn.addEventListener('click', performTripBack);
    const historyOpen = $('itin-history-open');
    if (historyOpen) historyOpen.addEventListener('click', openHistoryPanel);
    const historyUl = $('itin-history-ul');
    if (historyUl) {
      historyUl.addEventListener('click', function (e) {
        const row = e.target.closest('[data-history-id]');
        if (!row) return;
        loadSavedItinerary(row.getAttribute('data-history-id'));
      });
    }

    const resWrap = $('itin-result-section');
    if (resWrap) {
      resWrap.addEventListener('click', function (e) {
        const pick = e.target.closest('[data-pick-variant]');
        if (pick) {
          const i = parseInt(pick.getAttribute('data-pick-variant'), 10);
          if (!Number.isNaN(i) && tripEnvelope && tripEnvelope.variants && tripEnvelope.variants[i]) {
            chosenVariantIdx = i;
            renderChosenPlan();
          }
          return;
        }
        const swEl = e.target.closest('[data-switch-variant]');
        if (swEl) {
          const j = parseInt(swEl.getAttribute('data-switch-variant'), 10);
          if (!Number.isNaN(j) && tripEnvelope && tripEnvelope.variants && tripEnvelope.variants[j]) {
            chosenVariantIdx = j;
            renderChosenPlan();
          }
        }
      });
    }

    const daysHost = $('itin-days-container');
    if (daysHost) {
      daysHost.addEventListener('click', function (e) {
        const regenBtn = e.target.closest('[data-regen-day]');
        if (regenBtn) {
          e.preventDefault();
          const di = parseInt(regenBtn.getAttribute('data-regen-day'), 10);
          if (!Number.isNaN(di)) {
            regenerateDay(di);
          }
          return;
        }
        const card = e.target.closest('.itin-mini-card');
        if (!card) return;
        const pid = card.getAttribute('data-place-id');
        if (pid) openPlaceOverlay(pid);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
