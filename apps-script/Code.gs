/**
 * Easy Recipe Library - Apps Script web app.
 * Data layer: the "Easy Recipe Library - live data" Google Sheet (private, owner's account).
 * Deploy: Deploy > New deployment > Web app > Execute as: Me > Who has access: Only myself.
 * AI picks: DISABLED by default. Enabled only when the owner sets BOTH script
 *   properties AI_PROVIDER (=gemini) and GEMINI_API_KEY, after an explicit
 *   informed choice about the provider's data terms. Key stays server-side.
 *   Until then pickForMe returns deterministic unranked candidates, clearly
 *   labeled, and the chat route remains the real AI channel.
 */

// Sheet ID lives in Script Properties (key: SHEET_ID), not in source.
function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID script property is not set');
  return SpreadsheetApp.openById(id);
}

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Easy Recipe Library')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Read a tab as array of objects keyed by the header row. */
function readTab_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) return [];
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  var hdr = vals[0];
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    var o = {};
    for (var j = 0; j < hdr.length; j++) o[hdr[j]] = vals[i][j];
    out.push(o);
  }
  return out;
}

/** Videos for the index tab. Server-side filter keeps payloads small. */
function getVideos(filter) {
  filter = filter || {};
  var rows = readTab_('Videos');
  var q = (filter.q || '').toLowerCase();
  return rows.filter(function (r) {
    if (filter.channel && r.channel !== filter.channel) return false;
    // diet_hint is a title-derived hint, not a confirmed classification:
    // 'veg' matches only veg hints, 'non-veg' only explicit egg/meat hints.
    if (filter.diet === 'veg' && String(r.diet_hint || '').toLowerCase() !== 'veg') return false;
    if (filter.diet === 'non-veg' && !/egg|non-?veg|chicken|mutton|fish|prawn|meat/i.test(String(r.diet_hint || ''))) return false;
    if (filter.category && (r.category || '') !== filter.category) return false;
    if (q && String(r.title).toLowerCase().indexOf(q) === -1) return false;
    return true;
  }).slice(0, 300).map(function (r) {
    return {
      id: r.video_id, title: r.title, channel: r.channel, url: r.url,
      thumb: r.thumbnail_url, views: r.views, category: r.category,
      diet: r.diet_hint, published: r.yt_publish_date || '',
      status: r.extraction_status
    };
  });
}

function getChannels() {
  var seen = {}, out = [];
  readTab_('Videos').forEach(function (r) {
    if (r.channel && !seen[r.channel]) { seen[r.channel] = 1; out.push(r.channel); }
  });
  return out;
}

/** Verified recipes only. Raw extracts never appear here. */
function getRecipes() {
  return readTab_('Recipes').filter(function (r) {
    var v = String(r.verified).toLowerCase();
    return v === 'yes' || v === 'partial';
  }).map(function (r) {
    return {
      name: r.recipe_name, url: r.video_url, channel: r.channel,
      diet: r.diet, meal: r.meal_type, time: r.time_notes,
      ingredients: r.ingredients, steps: String(r.steps).split(' | '),
      source: r.source_note,
      partial: String(r.verified).toLowerCase() === 'partial'
    };
  });
}

function getHistory() {
  return readTab_('History').map(function (r) {
    return { date: r.date, id: r.video_id, title: r.title, state: r.state };
  });
}

/** Save-for-later / Choose this / Cooked. States stay separate. */
function saveHistory(videoId, title, state) {
  var allowed = { 'saved-for-later': 1, 'chosen': 1, 'cooked': 1 };
  if (!allowed[state]) throw new Error('bad state');
  ss_().getSheetByName('History').appendRow(
    [new Date().toISOString().slice(0, 10), videoId, title, state, 'app button']);
  return { ok: true };
}

/** IDs suggested or cooked in the last 30 days - the no-repeat exclusion. */
function recentExcludedIds_() {
  var cut = new Date(); cut.setDate(cut.getDate() - 30);
  var ex = {};
  readTab_('History').forEach(function (r) {
    if (r.state !== 'suggested' && r.state !== 'cooked') return;
    var d = new Date(r.date);
    if (d >= cut && r.video_id) ex[r.video_id] = 1;
  });
  readTab_('Picks').forEach(function (r) {
    var d = new Date(r.date);
    if (d < cut) return;
    String(r.suggested_video_ids || '').split(',').forEach(function (id) {
      id = id.trim(); if (id) ex[id] = 1;
    });
  });
  return ex;
}

/** Explicit egg/meat words -> nonveg; exact 'veg' -> veg; anything else is UNKNOWN. */
function dietClass_(diet) {
  var s = String(diet || '').trim().toLowerCase();
  if (s === 'veg' || s === 'vegetarian') return 'veg';
  if (/egg|non-?veg|chicken|mutton|fish|prawn|shrimp|crab|meat|beef|pork/i.test(s)) return 'nonveg';
  return 'unknown';
}

var NOTE_STOP_ = ('the a an and or for with without something anything me my we us our please want ' +
  'like love make made dish dishes recipe recipes food some that this these those today tonight kids kid ' +
  'friendly style type eat eating have get give show pick ideas idea').split(' ');

function parseNote_(note) {
  var exclusions = [];
  var rest = ' ' + String(note || '').toLowerCase().replace(/[,;!?]/g, '.').replace(/[^a-z\s.-]/g, ' ') + ' ';
  var exRe = /\b(?:no|without|avoid)\s+([a-z][a-z -]{0,40}?)(?=\s*(?:,|\.|$))/g, m;
  var spans = [];
  while ((m = exRe.exec(rest)) !== null) {
    m[1].split(/\s+(?:and|or)\s+/).forEach(function (part) {
      var t = part.trim();
      if (t && t.length >= 3 && NOTE_STOP_.indexOf(t) === -1) exclusions.push(t);
    });
    spans.push([m.index, m.index + m[0].length]);
  }
  spans.forEach(function (sp) { rest = rest.slice(0, sp[0]) + ' '.repeat(sp[1] - sp[0]) + rest.slice(sp[1]); });
  var seen = {}, keywords = [];
  rest.split(/[^a-z-]+/).forEach(function (w) {
    if (w.length >= 3 && NOTE_STOP_.indexOf(w) === -1 && !seen[w]) { seen[w] = 1; keywords.push(w); }
  });
  var exSeen = {}, exOut = [];
  exclusions.forEach(function (x) { if (!exSeen[x]) { exSeen[x] = 1; exOut.push(x); } });
  return { exclusions: exOut.slice(0, 6), keywords: keywords.slice(0, 6) };
}

/**
 * AI pick: 5 personalized suggestions from VERIFIED recipes only.
 * Deterministic exclusion (30-day no-repeat) happens in code, not the model.
 * The model only ranks/annotates candidates; output IDs are validated.
 */
function pickForMe(filter, note) {
  var ex = recentExcludedIds_();
  var candidates = readTab_('Recipes').filter(function (r) {
    if (String(r.verified).toLowerCase() !== 'yes') return false;
    var m = String(r.video_url).match(/v=([\w-]{11})/);
    var id = m ? m[1] : '';
    if (ex[id]) return false;
    // Conservative: 'Veg' strict; 'Non-veg' needs an explicit egg/meat
    // classification; unknown/unclassified diets match NEITHER filter and
    // appear only in an unfiltered pick.
    var dc = dietClass_(r.diet);
    if (filter && filter.diet === 'Veg' && dc !== 'veg') return false;
    if (filter && filter.diet === 'Non-veg' && dc !== 'nonveg') return false;
    if (filter && filter.diet && filter.diet !== 'Veg' && filter.diet !== 'Non-veg' && r.diet !== filter.diet) return false;
    if (filter && filter.meal && String(r.meal_type).toLowerCase().indexOf(filter.meal.toLowerCase()) === -1) return false;
    return true;
  });
  // One idea per video: a dish and its side (e.g. Pongal + Gotsu) never take
  // two of the five slots. Exclusion already works per video ID.
  var seenVid = {}, deduped = [];
  candidates.forEach(function (r) {
    var m = String(r.video_url).match(/v=([\w-]{11})/);
    var id = m ? m[1] : r.recipe_name;
    if (seenVid[id]) return;
    seenVid[id] = 1; deduped.push(r);
  });
  candidates = deduped;
  var chosen = candidates.slice(0, 5);
  var usedAI = false;
  var noteInfo = '';
  // Free-text note with AI OFF: conservative keyword rules only, and the
  // result says exactly what happened. Semantic wishes need the opt-in AI.
  if (note && String(note).trim()) {
    var parsed = parseNote_(note);
    var did = [];
    if (parsed.exclusions.length) {
      candidates = candidates.filter(function (r) {
        var hay = (r.recipe_name + ' ' + (r.ingredients || '')).toLowerCase();
        return !parsed.exclusions.some(function (x) { return hay.indexOf(x) !== -1; });
      });
      did.push('excluded recipes containing ' + parsed.exclusions.map(function (x) { return '"' + x + '"'; }).join(', '));
    }
    if (parsed.keywords.length && candidates.length) {
      var scored = candidates.map(function (r, idx) {
        var name = r.recipe_name.toLowerCase();
        var body = ((r.meal_type || '') + ' ' + (r.ingredients || '') + ' ' + (r.time_notes || '')).toLowerCase();
        var s = 0;
        parsed.keywords.forEach(function (k) {
          if (name.indexOf(k) !== -1) s += 2;
          else if (body.indexOf(k) !== -1) s += 1;
        });
        return { r: r, idx: idx, s: s };
      });
      if (scored.some(function (x) { return x.s > 0; })) {
        scored.sort(function (a, b) { return b.s - a.s || a.idx - b.idx; });
        candidates = scored.map(function (x) { return x.r; });
        did.push('prioritized matches for ' + parsed.keywords.map(function (k) { return '"' + k + '"'; }).join(', '));
      }
    }
    noteInfo = did.length
      ? 'Your note was applied with simple keyword matching (AI ranking is off): ' + did.join('; ') + '.'
      : 'Your note ("' + String(note).trim().slice(0, 60) + '") could not be applied - free-text wishes need AI ranking, which is off. Picks below are standard unranked matches.';
    chosen = candidates.slice(0, 5);
  }
  var props = PropertiesService.getScriptProperties();
  var provider = props.getProperty('AI_PROVIDER');
  var key = props.getProperty('GEMINI_API_KEY');
  // AI only runs after the owner's explicit provider/terms choice. No user
  // note text leaves this app until that choice exists; the prompt builder
  // below is the single place where request data can reach a provider.
  if (provider === 'gemini' && key && candidates.length > 0) {
    try {
      chosen = rankWithGemini_(candidates, filter, note, key);
      usedAI = true;
    } catch (e) {
      chosen = candidates.slice(0, 5); // honest fallback: unranked, labeled below
    }
  }
  // Record the suggestion set durably; chosen-vs-suggested split preserved.
  var ids = chosen.map(function (r) {
    var m = String(r.video_url).match(/v=([\w-]{11})/); return m ? m[1] : '';
  });
  ss_().getSheetByName('Picks').appendRow(
    [new Date().toISOString().slice(0, 10), JSON.stringify(filter || {}), note || '',
     ids.join(','), '', chosen.map(function (r) { return r.recipe_name; }).join(' | ')]);
  return {
    count: chosen.length, usedAI: usedAI, noteInfo: noteInfo,
    note: chosen.length < 5 ? 'Only ' + chosen.length + ' verified recipes qualify right now - no filler added.' : '',
    picks: chosen.map(function (r) {
      return { name: r.recipe_name, url: r.video_url, time: r.time_notes,
               diet: r.diet, meal: r.meal_type, reason: r._reason || '' };
    })
  };
}

/** Gemini ranking. Only public recipe data + this request's filters/note are sent. */
function rankWithGemini_(candidates, filter, note, key) {
  var list = candidates.map(function (r, i) {
    return i + ': ' + r.recipe_name + ' (' + r.diet + ', ' + r.meal_type + ', ' + r.time_notes + ')';
  }).join('\n');
  var prompt = 'You are picking recipes for a home cook. Candidate recipes:\n' + list +
    '\n\nFilters: ' + JSON.stringify(filter || {}) +
    '\nRequest note: ' + (note || 'none') +
    '\n\nPick up to 5 candidate numbers that best fit, best first. ' +
    'Reply with JSON only: [{"i":<number>,"reason":"<one short sentence>"}]. No other text.';
  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key,
    { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
  var body = JSON.parse(res.getContentText());
  var text = body.candidates[0].content.parts[0].text;
  var ranked = JSON.parse(text.replace(/```json|```/g, ''));
  var out = [];
  ranked.forEach(function (r) {
    var c = candidates[r.i];
    if (c) { c._reason = r.reason || ''; out.push(c); } // invalid model IDs dropped here
  });
  return out.length ? out.slice(0, 5) : candidates.slice(0, 5);
}
