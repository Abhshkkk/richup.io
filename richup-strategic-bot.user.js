// ==UserScript==
// @name         Richup.io Strategic Bot (experimental)
// @namespace    https://local.richup-strategic-bot
// @version      0.1.0
// @description  Strategy-driven autoplay for Richup.io: evaluates purchases, development, trades and jail from game state. Dry-run by default. Uses only the normal game UI.
// @match        https://richup.io/*
// @match        https://www.richup.io/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';
/* =====================================================================
 * RichupEngine — pure, DOM-free strategy engine.
 *
 * Nothing in this module touches the page. It consumes a normalized game
 * state plus a list of classified buttons and returns decisions with
 * reasons and scores. Everything here is testable in Node.
 *
 * CONVENTIONS
 *  - Unknown values are `null` (or `undefined` for square.owner), NEVER 0.
 *  - square.owner:  string = owned by that player id
 *                   null   = known to be unowned
 *                   undefined = ownership unknown
 *  - All game rules marked ASSUMPTION are standard-Monopoly defaults that
 *    have NOT been verified against Richup.io. Each one is a config value.
 * ===================================================================== */
const RichupEngine = (function () {
  'use strict';

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    // --- user-facing knobs ---
    reserveBase: 150,              // baseline cash buffer before threat adjustments
    reserveFloor: 50,              // absolute minimum buffer ever required
    riskTolerance: 0.5,            // 0 = very cautious, 1 = reckless
    purchaseAggressiveness: 0.5,   // 0 = picky, 1 = buy nearly everything affordable
    developmentAggressiveness: 0.5,
    // --- model parameters (ASSUMPTIONS, tunable by observation) ---
    horizonTurns: 30,              // how many more turns we value rent over
    developHorizonFactor: 0.6,     // buildings take time to be built and hit
    targetBuildLevel: 3,           // houses level used to value a monopoly's potential
    holdFraction: 0.85,            // resale/hold value of a property as fraction of price
    blockWeight: 0.35,             // weight on denying an opponent a property
    tradeCompletionProb: 0.12,     // chance of later completing a set via trade per opp-held square
    unownedCompletionProb: 0.55,   // chance of later winning each still-unowned set square
    unknownCompletionProb: 0.4,
    monopolyRentMultiplier: 2,     // ASSUMPTION: unimproved monopoly doubles base rent
    houseResaleFraction: 0.5,      // ASSUMPTION: buildings sell back at 50%
    mortgageInterest: 0.1,         // ASSUMPTION: unmortgage costs mortgage value + 10%
    rentGuessFraction: 0.1,        // fallback base rent = 10% of price when rents unknown
    houseCostGuessFraction: 0.5,   // fallback house cost = 50% of price when unknown
    avgDiceRoll: 7,
    liquidityCredit: 0.5,          // how much of liquid assets may offset the reserve
    unknownSquareBonus: 0.2,       // prior (fraction of price) for squares with unknown group/rent data
    blockMonopolyReserveFactor: 0.75,
    completeMonopolyReserveFactor: 0.5,
    // --- trade ---
    tradeMinEdge: 25,              // minimum improvement in standing to accept
    tradeLowConfidenceMultiplier: 2,
    decisiveMonopolyValue: 600,    // opponent monopoly worth more than this => hard veto
    tradeCashFloorFactor: 0.5,     // post-trade cash must be >= reserve * this
    unknownTradePolicy: 'decline', // 'decline' | 'pause' when trade terms unreadable
    // --- development ---
    minRoiBase: 1.1,               // min ΔEV/cost = minRoiBase - 0.6*devAggressiveness
    // --- degraded mode ---
    degradedPolicy: 'pause',       // 'pause' | 'decline' when purchase can't be evaluated
    allowConcede: false,           // never auto-click bankruptcy/give-up buttons unless true
    // --- execution gate ---
    maxStateAgeMs: 4000,
    actionVerifyTimeoutMs: 4000,
    duplicateCooldownMs: 1500,
    maxRetries: 3
  };

  function mergeConfig(overrides) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, overrides || {});
    ['riskTolerance', 'purchaseAggressiveness', 'developmentAggressiveness'].forEach(function (k) {
      cfg[k] = clamp(num(cfg[k]) == null ? DEFAULT_CONFIG[k] : num(cfg[k]), 0, 1);
    });
    ['reserveBase', 'reserveFloor'].forEach(function (k) {
      cfg[k] = Math.max(0, num(cfg[k]) == null ? DEFAULT_CONFIG[k] : num(cfg[k]));
    });
    return cfg;
  }

  // ------------------------------------------------------------------
  // Small utilities
  // ------------------------------------------------------------------
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function num(v) {
    if (isNum(v)) return v;
    if (typeof v === 'string') {
      const t = v.replace(/[,$\s]/g, '');
      if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    }
    return null;
  }
  function bool(v) { return typeof v === 'boolean' ? v : null; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function p2d6(d) { return d < 2 || d > 12 ? 0 : (6 - Math.abs(d - 7)) / 36; }

  // ------------------------------------------------------------------
  // State model, normalization, validation
  // ------------------------------------------------------------------
  /**
   * Normalize a loosely-typed state object into the engine schema.
   * Missing numbers become null (unknown), never 0.
   */
  function normalizeState(input) {
    input = input || {};
    const s = {
      meta: Object.assign({ source: 'unknown', capturedAt: 0, version: 0 }, input.meta || {}),
      phase: typeof input.phase === 'string' ? input.phase : 'unknown',
      meId: input.meId == null ? null : String(input.meId),
      currentPlayerId: input.currentPlayerId == null ? null : String(input.currentPlayerId),
      players: [],
      squares: [],
      bank: { houses: null, hotels: null },
      pending: { purchase: null, payment: null, trade: null },
      dice: null
    };
    (input.players || []).forEach(function (p, i) {
      if (!p) return;
      s.players.push({
        id: p.id == null ? 'p' + i : String(p.id),
        name: p.name == null ? '' : String(p.name),
        cash: num(p.cash),
        position: num(p.position),
        bankrupt: bool(p.bankrupt),
        inJail: bool(p.inJail),
        jailTurns: num(p.jailTurns),
        pardonCards: num(p.pardonCards),
        isBot: bool(p.isBot)
      });
    });
    (input.squares || []).forEach(function (q, i) {
      if (!q) return;
      let owner;
      if (q.owner === undefined) owner = undefined;
      else if (q.owner === null) owner = null;
      else owner = String(q.owner);
      s.squares.push({
        id: q.id == null ? 's' + i : String(q.id),
        index: isNum(q.index) ? q.index : i,
        name: q.name == null ? '' : String(q.name),
        type: q.type || 'other',                 // street | railroad | utility | tax | jail | other
        group: q.group == null ? null : String(q.group),
        price: num(q.price),
        rents: Array.isArray(q.rents) ? q.rents.map(num) : null,
        houseCost: num(q.houseCost),
        mortgageValue: num(q.mortgageValue),
        owner: owner,
        houses: num(q.houses),                   // 0-4 houses, 5 = hotel
        mortgaged: bool(q.mortgaged)
      });
    });
    if (input.bank) s.bank = { houses: num(input.bank.houses), hotels: num(input.bank.hotels) };
    if (input.pending) {
      const pp = input.pending;
      s.pending.purchase = pp.purchase ? { squareId: pp.purchase.squareId == null ? null : String(pp.purchase.squareId), price: num(pp.purchase.price) } : null;
      s.pending.payment = pp.payment ? { amount: num(pp.payment.amount), toId: pp.payment.toId == null ? null : String(pp.payment.toId) } : null;
      s.pending.trade = pp.trade || null;
    }
    if (input.dice) s.dice = input.dice;
    return s;
  }

  /**
   * Validate a normalized state. level: 'full' | 'degraded' | 'unusable'.
   *  unusable: no way to identify the player -> only mechanical actions allowed
   *  degraded: player known but cash or board unknown -> no valuation-based decisions
   */
  function validateState(s) {
    const fatal = [], warnings = [];
    if (!s || !Array.isArray(s.players) || s.players.length === 0) fatal.push('no players');
    const me = s && s.players ? s.players.find(function (p) { return p.id === s.meId; }) : null;
    if (!me) fatal.push('own player not identified');
    if (me && me.cash == null) warnings.push('own cash unknown');
    if (me && me.bankrupt === true) fatal.push('own player is bankrupt');
    if (!s || !s.squares || s.squares.length === 0) warnings.push('board unknown');
    if (s && s.squares) {
      const priced = s.squares.filter(function (q) { return q.type === 'street' || q.type === 'railroad' || q.type === 'utility'; });
      if (priced.length && priced.some(function (q) { return q.price == null; })) warnings.push('some property prices unknown');
      if (priced.length && priced.every(function (q) { return q.owner === undefined; })) warnings.push('ownership unknown');
    }
    let level = 'full';
    if (fatal.length) level = 'unusable';
    else if (warnings.indexOf('own cash unknown') >= 0 || warnings.indexOf('board unknown') >= 0) level = 'degraded';
    return { ok: fatal.length === 0, level: level, fatal: fatal, warnings: warnings };
  }

  // ------------------------------------------------------------------
  // Board helpers
  // ------------------------------------------------------------------
  function getPlayer(s, id) { return s.players.find(function (p) { return p.id === id; }) || null; }
  function getMe(s) { return getPlayer(s, s.meId); }
  function alive(s) { return s.players.filter(function (p) { return p.bankrupt !== true; }); }
  function boardSize(s) { return s.squares.length || 40; }
  function sqById(s, id) { return s.squares.find(function (q) { return q.id === id; }) || null; }
  function members(s, sq) {
    if (!sq.group) return [sq];
    return s.squares.filter(function (q) { return q.group === sq.group; });
  }
  function ownedBy(s, pid) { return s.squares.filter(function (q) { return q.owner === pid; }); }
  function countOwnedInGroup(s, group, pid) {
    return s.squares.filter(function (q) { return q.group === group && q.owner === pid; }).length;
  }
  function hasMonopoly(s, pid, group) {
    if (!group) return false;
    const m = s.squares.filter(function (q) { return q.group === group; });
    return m.length >= 2 && m.every(function (q) { return q.owner === pid; });
  }
  function isStreet(q) { return q.type === 'street'; }
  function lvl(q) { return isNum(q.houses) ? q.houses : 0; }

  // ------------------------------------------------------------------
  // Valuation model
  // ------------------------------------------------------------------
  function houseCostOf(cfg, q) {
    if (isNum(q.houseCost)) return q.houseCost;
    return isNum(q.price) ? q.price * cfg.houseCostGuessFraction : null;
  }
  function baseRentOf(cfg, q) {
    if (q.rents && isNum(q.rents[0])) return q.rents[0];
    return isNum(q.price) ? q.price * cfg.rentGuessFraction : 0;
  }
  function rentAtLevel(cfg, q, level) {
    if (q.rents && q.rents.length > 1) {
      const r = q.rents[Math.min(level, q.rents.length - 1)];
      if (isNum(r)) return r;
    }
    return baseRentOf(cfg, q) * Math.pow(3, level);   // rough estimate when schedule unknown
  }

  /** Rent the current owner would collect right now on a square. */
  function rentOf(s, cfg, q, ownerId) {
    if (q.mortgaged === true) return 0;
    if (isStreet(q)) {
      const h = lvl(q);
      if (h > 0) return rentAtLevel(cfg, q, h);
      const base = baseRentOf(cfg, q);
      return hasMonopoly(s, ownerId, q.group) ? base * cfg.monopolyRentMultiplier : base;
    }
    if (q.type === 'railroad') {
      const n = Math.max(1, countOwnedInGroup(s, q.group, ownerId));
      if (q.rents && isNum(q.rents[n - 1])) return q.rents[n - 1];
      const base = q.rents && isNum(q.rents[0]) ? q.rents[0] : (isNum(q.price) ? q.price * 0.125 : 25);
      return base * Math.pow(2, n - 1);
    }
    if (q.type === 'utility') {
      const n = Math.max(1, countOwnedInGroup(s, q.group, ownerId));
      const mult = q.rents && isNum(q.rents[n - 1]) ? q.rents[n - 1] : [4, 10][Math.min(n, 2) - 1];
      return mult * cfg.avgDiceRoll;
    }
    return 0;
  }

  /** Expected rent income over the horizon from one square, per opponent landing 1/n per turn. */
  function incomeEV(s, cfg, ownerId, rent) {
    const others = alive(s).filter(function (p) { return p.id !== ownerId; }).length;
    return cfg.horizonTurns * others / boardSize(s) * rent;
  }

  /** Net EV of developing a street to the target level, from the owner's view (before probability weighting). */
  function developmentPotential(s, cfg, q, ownerId) {
    const hc = houseCostOf(cfg, q);
    if (hc == null) return 0;
    const maxLevel = q.rents && q.rents.length > 1 ? q.rents.length - 1 : 5;
    const L = Math.min(cfg.targetBuildLevel, maxLevel);
    const rentL = rentAtLevel(cfg, q, L);
    const others = alive(s).filter(function (p) { return p.id !== ownerId; }).length;
    const ev = cfg.horizonTurns * cfg.developHorizonFactor * others / boardSize(s) * rentL;
    return ev - hc * L * (1 - cfg.houseResaleFraction);
  }

  function completionProbability(s, cfg, q, pid) {
    if (!isStreet(q) || !q.group) return 0;
    const missing = members(s, q).filter(function (m) { return m.owner !== pid; });
    if (missing.length === 0) return 1;
    let p = 1;
    missing.forEach(function (m) {
      if (m.owner === null) p *= cfg.unownedCompletionProb;
      else if (m.owner === undefined) p *= cfg.unknownCompletionProb;
      else p *= cfg.tradeCompletionProb;
    });
    return p;
  }

  /** Value (in cash-equivalent) of one owned square to its owner. */
  function assetValue(s, cfg, q, pid) {
    const price = isNum(q.price) ? q.price : 0;
    if (q.mortgaged === true) {
      const mv = isNum(q.mortgageValue) ? q.mortgageValue : price * 0.5;
      return price * cfg.holdFraction - mv * (1 + cfg.mortgageInterest);
    }
    let val = price * cfg.holdFraction;
    const inc = incomeEV(s, cfg, pid, rentOf(s, cfg, q, pid));
    val += inc;
    if (isStreet(q) && q.group) {
      const pot = developmentPotential(s, cfg, q, pid);
      const p = completionProbability(s, cfg, q, pid);
      if (lvl(q) === 0 || !hasMonopoly(s, pid, q.group)) val += p * Math.max(0, pot - inc);
      const hc = houseCostOf(cfg, q);
      if (lvl(q) > 0 && hc != null) val += lvl(q) * hc * cfg.houseResaleFraction;
    }
    return val;
  }

  function liabilityEV(s, cfg, pid) {
    let total = 0;
    s.squares.forEach(function (q) {
      if (typeof q.owner === 'string' && q.owner !== pid) {
        const owner = getPlayer(s, q.owner);
        if (owner && owner.bankrupt === true) return;
        total += cfg.horizonTurns / boardSize(s) * rentOf(s, cfg, q, q.owner);
      }
    });
    return total;
  }

  function avgKnownCash(s) {
    const k = s.players.filter(function (p) { return isNum(p.cash); });
    return k.length ? k.reduce(function (a, p) { return a + p.cash; }, 0) / k.length : 0;
  }

  /** Cash-equivalent position of a player (cash + assets - expected rent liability). */
  function positionValue(s, cfg, pid) {
    const p = getPlayer(s, pid);
    if (!p) return 0;
    const cash = isNum(p.cash) ? p.cash : avgKnownCash(s);
    let v = cash;
    ownedBy(s, pid).forEach(function (q) { v += assetValue(s, cfg, q, pid); });
    return v - liabilityEV(s, cfg, pid);
  }

  /** How far ahead of the field a player stands (blend of mean and strongest opponent). */
  function standing(s, cfg, pid) {
    const others = alive(s).filter(function (p) { return p.id !== pid; });
    const mine = positionValue(s, cfg, pid);
    if (!others.length) return mine;
    const vals = others.map(function (p) { return positionValue(s, cfg, p.id); });
    const mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    return mine - (0.5 * mean + 0.5 * Math.max.apply(null, vals));
  }

  function valueGainIfOwner(s, cfg, sq, pid) {
    const before = positionValue(s, cfg, pid);
    const t = clone(s);
    const tq = sqById(t, sq.id);
    if (tq) tq.owner = pid;
    return positionValue(t, cfg, pid) - before;
  }

  // ------------------------------------------------------------------
  // Cash reserve and threat model
  // ------------------------------------------------------------------
  function computeThreat(s, cfg, pid, posOverride) {
    const me = getPlayer(s, pid);
    const pos = isNum(posOverride) ? posOverride : (me ? me.position : null);
    const n = boardSize(s);
    const items = [];
    s.squares.forEach(function (q) {
      let rent = 0;
      if (typeof q.owner === 'string' && q.owner !== pid) rent = rentOf(s, cfg, q, q.owner);
      else if (q.type === 'tax' && isNum(q.price)) rent = q.price;
      if (rent > 0) items.push({ q: q, rent: rent });
    });
    if (!items.length) return { worst: 0, sumRange: 0, expected: 0, positionKnown: isNum(pos) };
    if (!isNum(pos)) {
      const worst = Math.max.apply(null, items.map(function (i) { return i.rent; })) * 0.6;
      return { worst: worst, sumRange: worst, expected: worst / 4, positionKnown: false };
    }
    let worst = 0, sum = 0, expected = 0;
    items.forEach(function (i) {
      const d = ((i.q.index - pos) % n + n) % n;
      if (d >= 2 && d <= 12) {
        worst = Math.max(worst, i.rent);
        sum += i.rent;
        expected += p2d6(d) * i.rent;
      }
    });
    return { worst: worst, sumRange: sum, expected: expected, positionKnown: true };
  }

  function liquidity(s, cfg, pid) {
    let total = 0;
    ownedBy(s, pid).forEach(function (q) {
      const hc = houseCostOf(cfg, q);
      if (lvl(q) > 0 && hc != null) total += lvl(q) * hc * cfg.houseResaleFraction;
      else if (q.mortgaged !== true && isNum(q.price)) {
        const anyBuildings = members(s, q).some(function (m) { return lvl(m) > 0; });
        if (!anyBuildings) total += isNum(q.mortgageValue) ? q.mortgageValue : q.price * 0.5;
      }
    });
    return total;
  }

  /** Dynamic reserve: base buffer + rent threat ahead + pending payments - liquidity credit. */
  function computeReserve(s, cfg, pid) {
    const risk = cfg.riskTolerance;
    const base = cfg.reserveBase * (1.5 - risk);
    const th = computeThreat(s, cfg, pid);
    const threatPart = th.worst * (1 - 0.7 * risk) + 0.25 * Math.max(0, th.sumRange - th.worst) * (1 - risk);
    const pending = s.pending.payment && isNum(s.pending.payment.amount) ? s.pending.payment.amount : 0;
    const liq = liquidity(s, cfg, pid);
    const credit = Math.min(cfg.liquidityCredit * liq, 0.5 * (base + threatPart));
    const reserve = Math.max(cfg.reserveFloor, base + threatPart + pending - credit);
    return { reserve: reserve, base: base, threatWorst: th.worst, threatExpected: th.expected, pending: pending, credit: credit, positionKnown: th.positionKnown };
  }

  // ------------------------------------------------------------------
  // A. Purchase decision (and B. color-set priority)
  // ------------------------------------------------------------------
  function decidePurchase(s, cfg, pending) {
    const me = getMe(s);
    if (!me) return { action: 'defer', reason: 'own player unknown' };
    if (!isNum(me.cash)) return { action: 'defer', reason: 'own cash unknown' };
    pending = pending || s.pending.purchase || {};
    let sq = pending.squareId ? sqById(s, pending.squareId) : null;
    if (!sq && isNum(me.position)) sq = s.squares.find(function (q) { return q.index === me.position; }) || null;
    // The square under the token must actually be purchasable, else the position data is unreliable: fall back to the button price.
    if (sq && sq.type !== 'street' && sq.type !== 'railroad' && sq.type !== 'utility') sq = null;
    const price = isNum(pending.price) ? pending.price : (sq && isNum(sq.price) ? sq.price : null);
    if (price == null) return { action: 'defer', reason: 'price unknown' };
    const synthetic = !sq;
    if (!sq) {
      // Board unknown: synthetic square so valuation degrades gracefully (low confidence).
      sq = { id: '__synthetic__', index: -1, name: '', type: 'street', group: null, price: price, rents: null,
             houseCost: null, mortgageValue: null, owner: null, houses: 0, mortgaged: false };
      s = clone(s); s.squares.push(sq);
    }
    if (price > me.cash) return { action: 'decline', reason: 'cannot afford ($' + price + ' > cash $' + me.cash + ')', price: price };

    const t = clone(s);
    const tsq = sqById(t, sq.id);
    tsq.price = tsq.price == null ? price : tsq.price;
    tsq.owner = null;
    let gain = valueGainIfOwner(t, cfg, tsq, me.id);
    if (synthetic) gain += price * cfg.unknownSquareBonus;      // no group/rent data: assume typical set potential (low confidence)
    let block = 0;
    alive(t).filter(function (p) { return p.id !== me.id; }).forEach(function (o) {
      const g = valueGainIfOwner(t, cfg, tsq, o.id) - price * cfg.holdFraction;
      if (g > block) block = g;
    });
    block *= cfg.blockWeight;

    const grp = tsq.group ? members(t, tsq) : [];
    const others = grp.filter(function (m) { return m.id !== tsq.id; });
    const completes = grp.length >= 2 && others.every(function (m) { return m.owner === me.id; });
    const blocks = grp.length >= 2 && alive(t).some(function (o) {
      return o.id !== me.id && others.length > 0 && others.every(function (m) { return m.owner === o.id; });
    });

    const r = computeReserve(t, cfg, me.id);
    const factor = completes ? cfg.completeMonopolyReserveFactor : (blocks ? cfg.blockMonopolyReserveFactor : 1);
    const need = r.reserve * factor;
    const after = me.cash - price;
    const score = gain + block - price;
    const tilt = (cfg.purchaseAggressiveness - 0.5) * 0.5 * price;     // aggressive => tolerate negative score
    const valueOk = score + tilt >= 0;
    const cashOk = after >= need;
    const info = { price: price, gain: round(gain), block: round(block), score: round(score), reserve: round(r.reserve),
                   need: round(need), afterCash: after, completes: completes, blocks: blocks, square: tsq.name || tsq.id };

    if (valueOk && cashOk) {
      return Object.assign({ action: 'buy', reason: 'value ' + round(gain) + (block > 0 ? ' + block ' + round(block) : '') +
        ' > price ' + price + '; cash after $' + after + ' >= reserve $' + round(need) + (completes ? ' (completes set)' : '') }, info);
    }
    // Justified dip below reserve: completing a set with strongly positive score, never below hard floor.
    if (completes && !cashOk && valueOk && score > 0.5 * price && after >= cfg.reserveFloor && cfg.riskTolerance >= 0.3) {
      return Object.assign({ action: 'buy', risky: true, reason: 'completes set, score ' + round(score) +
        ' justifies dipping below reserve $' + round(need) + ' (after $' + after + ')' }, info);
    }
    return Object.assign({ action: 'decline', reason: !cashOk ? 'cash after purchase $' + after + ' below reserve $' + round(need)
      : 'score ' + round(score) + ' not worth price ' + price }, info);
  }
  function round(v) { return Math.round(v * 10) / 10; }

  // ------------------------------------------------------------------
  // C. Houses and hotels
  // ------------------------------------------------------------------
  function decideBuild(s, cfg) {
    const me = getMe(s);
    if (!me || !isNum(me.cash)) return { action: 'none', reason: 'cash unknown', candidates: [] };
    const cands = [];
    const groups = {};
    ownedBy(s, me.id).forEach(function (q) { if (isStreet(q) && q.group) groups[q.group] = true; });
    const r = computeReserve(s, cfg, me.id);
    const reserve = r.reserve * (1.2 - 0.4 * cfg.developmentAggressiveness);
    const minRoi = cfg.minRoiBase - 0.6 * cfg.developmentAggressiveness;
    const others = alive(s).filter(function (p) { return p.id !== me.id; });

    Object.keys(groups).forEach(function (g) {
      if (!hasMonopoly(s, me.id, g)) return;
      const grp = s.squares.filter(function (q) { return q.group === g; });
      if (grp.some(function (q) { return q.mortgaged === true; })) return;           // ASSUMPTION: no building with a mortgaged set member
      if (grp.some(function (q) { return !isStreet(q); })) return;
      const levels = grp.map(lvl);
      const minL = Math.min.apply(null, levels);
      grp.forEach(function (q) {
        if (lvl(q) !== minL) return;                                                 // even-building rule
        const next = lvl(q) + 1;
        if (next > 5) return;
        const hc = houseCostOf(cfg, q);
        if (hc == null) return;
        if (next < 5 && s.bank.houses != null && s.bank.houses < 1) return;
        if (next === 5 && s.bank.hotels != null && s.bank.hotels < 1) return;
        const maxLevel = q.rents && q.rents.length > 1 ? q.rents.length - 1 : 5;
        if (next > maxLevel) return;
        const baseNow = lvl(q) > 0 ? rentAtLevel(cfg, q, lvl(q)) : baseRentOf(cfg, q) * cfg.monopolyRentMultiplier;
        const gainRent = rentAtLevel(cfg, q, next) - baseNow;
        let prox = 1;
        others.forEach(function (o) {
          if (isNum(o.position)) {
            const d = ((q.index - o.position) % boardSize(s) + boardSize(s)) % boardSize(s);
            prox += 0.5 * p2d6(d);
          }
        });
        prox = Math.min(prox, 1.5);
        const ev = cfg.horizonTurns * others.length / boardSize(s) * gainRent * prox;
        const net = ev - hc * (1 - cfg.houseResaleFraction);
        const roi = ev / hc;
        const cashOk = me.cash - hc >= reserve;
        cands.push({ squareId: q.id, name: q.name, group: g, fromLevel: lvl(q), toLevel: next, cost: hc,
                     ev: round(ev), net: round(net), roi: round(roi), cashOk: cashOk,
                     ok: cashOk && net > 0 && roi >= minRoi });
      });
    });
    const ok = cands.filter(function (c) { return c.ok; }).sort(function (a, b) { return b.net - a.net; });
    if (ok.length) {
      const b = ok[0];
      return { action: 'build', best: b, candidates: cands,
        reason: 'build ' + (b.toLevel === 5 ? 'hotel' : 'house #' + b.toLevel) + ' on ' + (b.name || b.squareId) +
          ': EV ' + b.ev + ' vs cost ' + b.cost + ' (ROI ' + b.roi + '), cash after $' + (me.cash - b.cost) + ' >= reserve $' + round(reserve) };
    }
    const why = cands.length ? (cands.every(function (c) { return !c.cashOk; }) ? 'cash would fall below reserve $' + round(reserve) : 'ROI/EV too low') : 'no legal development (need full set, even build, supply)';
    return { action: 'none', candidates: cands, reason: why };
  }

  // ------------------------------------------------------------------
  // E. Liquidation planning / bankruptcy avoidance
  // ------------------------------------------------------------------
  function liquidationOptions(s, cfg, pid) {
    const opts = [];
    const mine = ownedBy(s, pid);
    mine.forEach(function (q) {
      const hc = houseCostOf(cfg, q);
      if (isStreet(q) && lvl(q) > 0 && hc != null) {
        const grp = members(s, q);
        const maxL = Math.max.apply(null, grp.map(lvl));
        if (lvl(q) === maxL) opts.push({ type: 'sell-house', squareId: q.id, name: q.name, raise: hc * cfg.houseResaleFraction });
      } else if (q.mortgaged !== true && isNum(q.price)) {
        if (members(s, q).some(function (m) { return lvl(m) > 0; })) return;
        opts.push({ type: 'mortgage', squareId: q.id, name: q.name, raise: isNum(q.mortgageValue) ? q.mortgageValue : q.price * 0.5 });
      }
    });
    return opts;
  }

  function planLiquidation(s, cfg, needed) {
    const me = getMe(s);
    if (!me || !isNum(me.cash)) return { solvent: null, steps: [], reason: 'cash unknown' };
    let shortfall = needed - me.cash;
    if (shortfall <= 0) return { solvent: true, steps: [], shortfall: 0, reason: 'cash covers $' + needed };
    let t = clone(s);
    const steps = [];
    for (let guard = 0; guard < 200 && shortfall > 0; guard++) {
      const meT = getMe(t);
      const opts = liquidationOptions(t, cfg, meT.id);
      if (!opts.length) break;
      const base = positionValue(t, cfg, meT.id);
      let best = null;
      opts.forEach(function (o) {
        const t2 = clone(t);
        const q2 = sqById(t2, o.squareId);
        if (o.type === 'sell-house') q2.houses = lvl(q2) - 1; else q2.mortgaged = true;
        getMe(t2).cash += o.raise;
        const loss = base - positionValue(t2, cfg, meT.id);          // value destroyed, cash excluded effect included
        const cost = loss / Math.max(1, o.raise);
        if (!best || cost < best.cost) best = { o: o, cost: cost, t2: t2 };
      });
      steps.push(Object.assign({}, best.o, { lossPerDollar: round(best.cost) }));
      t = best.t2;
      shortfall = needed - getMe(t).cash;
    }
    if (shortfall > 0) {
      return { solvent: false, steps: [], shortfall: round(shortfall),
        reason: 'insolvent: even full liquidation leaves $' + round(shortfall) + ' short; selling gains nothing, prefer a concede/bankrupt option if the UI offers one' };
    }
    return { solvent: true, steps: steps, shortfall: 0, reason: 'raise $' + round(needed - me.cash) + ' via ' + steps.length + ' step(s), cheapest value-loss first' };
  }

  // ------------------------------------------------------------------
  // F. Jail
  // ------------------------------------------------------------------
  /** opts: {fee:number|null, hasCard:boolean, canRoll:boolean} */
  function decideJail(s, cfg, opts) {
    const me = getMe(s);
    const fee = opts && isNum(opts.fee) ? opts.fee : null;
    const hasCard = !!(opts && opts.hasCard);
    const canRoll = !opts || opts.canRoll !== false;
    if (!me || !isNum(me.cash)) {
      // Without cash we cannot judge affordability; a free card is always safe.
      if (hasCard) return { action: 'card', reason: 'card available, cash unknown' };
      return canRoll ? { action: 'roll', reason: 'cash unknown: roll for doubles (free)' } : { action: 'none', reason: 'no safe option' };
    }
    const priced = s.squares.filter(function (q) { return q.type === 'street' || q.type === 'railroad' || q.type === 'utility'; });
    const unowned = priced.filter(function (q) { return q.owner === null; }).length;
    const unownedFrac = priced.length ? unowned / priced.length : 0.5;
    const jailSq = s.squares.find(function (q) { return q.type === 'jail'; });
    const th = computeThreat(s, cfg, me.id, jailSq ? jailSq.index : 10);
    const r = computeReserve(s, cfg, me.id);
    const early = unownedFrac >= 0.35;
    const dangerous = th.worst > 0.35 * me.cash || th.expected > 0.08 * me.cash;
    const canPay = fee != null && me.cash - fee >= r.reserve * 0.5;

    if (early) {
      if (hasCard) return { action: 'card', reason: 'early game (' + Math.round(unownedFrac * 100) + '% unowned): use card to resume buying' };
      if (canPay) return { action: 'pay', reason: 'early game: pay $' + fee + ' to resume buying' };
    } else if (dangerous && canRoll) {
      return { action: 'roll', reason: 'late game & board dangerous (worst rent ' + round(th.worst) + '): stay in jail, roll for doubles' };
    } else {
      if (hasCard) return { action: 'card', reason: 'mid game: free card beats risk of waiting' };
      if (canPay && me.cash - fee >= r.reserve) return { action: 'pay', reason: 'mid game: pay $' + fee + ', cash stays above reserve' };
    }
    if (canRoll) return { action: 'roll', reason: 'roll for doubles (free); paying would breach reserve' };
    if (fee != null && me.cash >= fee) return { action: 'pay', reason: 'only legal option is paying $' + fee };
    if (hasCard) return { action: 'card', reason: 'only legal option is the card' };
    return { action: 'none', reason: 'no legal jail action detected' };
  }

  // ------------------------------------------------------------------
  // D. Trades
  // ------------------------------------------------------------------
  /**
   * trade = { id, partnerId, give:{cash, squares:[ids]}, get:{cash, squares:[ids]} }
   * "give"/"get" are from the perspective of `perspectiveId` (default: me).
   */
  function applyTrade(s, trade, perspectiveId) {
    const t = clone(s);
    const a = getPlayer(t, perspectiveId), b = getPlayer(t, trade.partnerId);
    if (!a || !b) return { error: 'unknown trade party' };
    const gc = num(trade.give && trade.give.cash) || 0, rc = num(trade.get && trade.get.cash) || 0;
    if (isNum(a.cash)) a.cash += rc - gc;
    if (isNum(b.cash)) b.cash += gc - rc;
    for (const id of (trade.give && trade.give.squares) || []) {
      const q = sqById(t, id);
      if (!q) return { error: 'unknown square ' + id };
      if (q.owner !== perspectiveId) return { error: 'square ' + id + ' not owned by giver' };
      if (lvl(q) > 0) return { error: 'square ' + id + ' has buildings' };
      q.owner = trade.partnerId;
    }
    for (const id of (trade.get && trade.get.squares) || []) {
      const q = sqById(t, id);
      if (!q) return { error: 'unknown square ' + id };
      if (q.owner !== trade.partnerId) return { error: 'square ' + id + ' not owned by partner' };
      if (lvl(q) > 0) return { error: 'square ' + id + ' has buildings' };
      q.owner = perspectiveId;
    }
    return { state: t };
  }

  function evaluateTrade(s, cfg, trade, perspectiveId, opts) {
    opts = opts || {};
    perspectiveId = perspectiveId || s.meId;
    const me = getPlayer(s, perspectiveId);
    const out = { action: 'decline', vetoes: [], notes: [] };
    if (!me) { out.vetoes.push('player unknown'); return out; }
    if (!isNum(me.cash)) { out.vetoes.push('cash unknown: cannot evaluate'); return out; }
    const gc = num(trade.give && trade.give.cash) || 0;
    if (gc > me.cash) { out.vetoes.push('cannot afford the cash component'); return out; }

    const applied = applyTrade(s, trade, perspectiveId);
    if (applied.error) { out.vetoes.push(applied.error); return out; }
    const t = applied.state;

    // Low confidence if any traded square lacks price or rent data.
    const traded = ((trade.give && trade.give.squares) || []).concat((trade.get && trade.get.squares) || []);
    const lowConf = traded.some(function (id) { const q = sqById(s, id); return !q || q.price == null || !q.rents; });
    if (lowConf) out.notes.push('low confidence: missing price/rent data on traded squares');

    // Hard veto: new decisive opponent monopoly.
    const before = standing(s, cfg, perspectiveId);
    const after = standing(t, cfg, perspectiveId);
    const partner = trade.partnerId;
    const groups = {};
    s.squares.forEach(function (q) { if (q.group) groups[q.group] = true; });
    Object.keys(groups).forEach(function (g) {
      alive(t).forEach(function (o) {
        if (o.id === perspectiveId) return;
        if (hasMonopoly(t, o.id, g) && !hasMonopoly(s, o.id, g)) {
          const grp = t.squares.filter(function (q) { return q.group === g; });
          let potential = 0;
          grp.forEach(function (q) { if (isStreet(q)) potential += Math.max(0, developmentPotential(t, cfg, q, o.id)); });
          if (isStreet(grp[0]) && potential >= cfg.decisiveMonopolyValue && !opts.skipMonopolyVeto)
            out.vetoes.push('gives ' + (o.name || o.id) + ' a decisive monopoly (' + g + ', potential ~' + round(potential) + ')');
          else out.notes.push('creates a monopoly for ' + (o.name || o.id) + ' in ' + g + ' (potential ~' + round(potential) + ')');
        }
      });
    });

    const r = computeReserve(t, cfg, perspectiveId);
    const meAfter = getPlayer(t, perspectiveId);
    if (isNum(meAfter.cash) && meAfter.cash < 0) out.vetoes.push('would leave negative cash');
    else if (isNum(meAfter.cash) && meAfter.cash < r.reserve * cfg.tradeCashFloorFactor && gc > 0)
      out.vetoes.push('post-trade cash $' + round(meAfter.cash) + ' below ' + Math.round(cfg.tradeCashFloorFactor * 100) + '% of reserve $' + round(r.reserve));

    const need = cfg.tradeMinEdge * (lowConf ? cfg.tradeLowConfidenceMultiplier : 1);
    out.standingBefore = round(before);
    out.standingAfter = round(after);
    out.delta = round(after - before);
    out.needed = need;
    if (!out.vetoes.length && after - before >= need) {
      out.action = 'accept';
      out.reason = 'standing improves by ' + out.delta + ' (>= ' + need + ')';
    } else {
      out.reason = out.vetoes.length ? 'vetoed: ' + out.vetoes.join('; ') : 'standing change ' + out.delta + ' < required ' + need;
    }
    return out;
  }

  /** Suggest outgoing offers that complete one of my sets and are win-win under the model. Advisory only. */
  function proposeTrades(s, cfg) {
    const me = getMe(s);
    const proposals = [];
    if (!me || !isNum(me.cash)) return proposals;
    const groups = {};
    s.squares.forEach(function (q) { if (isStreet(q) && q.group) groups[q.group] = true; });
    Object.keys(groups).forEach(function (g) {
      const grp = s.squares.filter(function (q) { return q.group === g; });
      const missing = grp.filter(function (q) { return q.owner !== me.id; });
      if (missing.length !== 1) return;
      const target = missing[0];
      if (typeof target.owner !== 'string' || target.mortgaged === true || lvl(target) > 0) return;
      const price = isNum(target.price) ? target.price : 100;
      for (let mult = 0.5; mult <= 3.01; mult += 0.25) {
        const cash = Math.round(price * mult / 10) * 10;
        if (cash > me.cash) break;
        const mine = { id: 'proposal', partnerId: target.owner, give: { cash: cash, squares: [] }, get: { cash: 0, squares: [target.id] } };
        const my = evaluateTrade(s, cfg, mine, me.id);
        if (my.action !== 'accept') continue;
        // Judge the partner on standing only: a monopoly-aware partner would likely refuse anything that
        // completes my set, so we flag that instead of silently treating the offer as a sure thing.
        const theirs = evaluateTrade(s, cfg, { id: 'x', partnerId: me.id, give: mine.get, get: mine.give }, target.owner, { skipMonopolyVeto: true });
        if (theirs.delta != null && theirs.delta >= 0 && theirs.vetoes.length === 0) {
          proposals.push({ trade: mine, myDelta: my.delta, theirDelta: theirs.delta,
            note: 'offer $' + cash + ' for ' + (target.name || target.id) + ' to complete ' + g +
              ' (partner gains ' + theirs.delta + ' by the model, but a monopoly-aware partner may still refuse)' });
          break;
        }
      }
    });
    return proposals.sort(function (a, b) { return b.myDelta - a.myDelta; });
  }

  // ------------------------------------------------------------------
  // Button classification (pure text rules)
  // ------------------------------------------------------------------
  /**
   * Patterns for kinds marked [ref1] come from Reference 1's DOM patterns and are UNVERIFIED
   * against the current site. Everything here is text-based and must be re-checked with a DOM sample.
   */
  function classifyButton(rawText) {
    // Strip countdown suffixes such as "(12s)" so a ticking timer doesn't change the label/fingerprint every second.
    const t = String(rawText || '').replace(/\(\s*\d{1,3}\s*s(ec(onds?)?)?\s*\)|\b\d{1,3}\s?s\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const pm = /\$\s?(\d[\d,]*)/.exec(t);
    const price = pm ? Number(pm[1].replace(/,/g, '')) : null;
    let kind = 'other';
    if (!t) kind = 'other';
    else if (/(bankrupt|give up|surrender|resign|concede)/.test(t)) kind = 'concede';
    else if (/[dD]on[’'’]?t.*buy/.test(t) || /do not.*buy/.test(t)) kind = 'dont_buy';          // [ref1]
    else if (/\bunmortgage\b|\bredeem\b/.test(t)) kind = 'unmortgage';
    else if (/\bmortgage\b/.test(t)) kind = 'mortgage';
    else if (/^buy\b/.test(t) || /\bbuy\b/.test(t)) kind = 'buy';       // [ref1]
    else if (/get free for/.test(t)) kind = 'jail_pay';                 // [ref1]
    else if (/pardon|get out of jail|use card/.test(t)) kind = 'jail_card'; // [ref1]
    else if (/\bauction\b/.test(t)) kind = 'auction';                   // [ref1]
    else if (/\broll\b/.test(t)) kind = 'roll';                         // [ref1]
    else if (/end turn/.test(t)) kind = 'end_turn';                     // [ref1]
    else if (/^(accept)\b/.test(t)) kind = 'accept_trade';
    else if (/^(decline|reject)\b/.test(t)) kind = 'decline_trade';
    else if (/^(pass|skip)$/.test(t)) kind = 'pass';                    // [ref1]
    else if (/^(ok|okay|continue|got it)$/.test(t)) kind = 'confirm';   // [ref1]
    else if (/^(build|buy house|buy hotel|upgrade)\b|\b(build|upgrade)\b/.test(t)) kind = 'build';
    else if (/^sell\b/.test(t)) kind = 'sell';
    else if (/change color/.test(t)) kind = 'lobby_marker';             // [ref1]
    return { kind: kind, price: price, text: t };
  }

  // ------------------------------------------------------------------
  // Action selection (priority system)
  // ------------------------------------------------------------------
  /**
   * ctx = { state, validation, buttons:[{id,kind,price,text,enabled,visible}], cfg }
   * Returns one of:
   *   {kind:'click', target:<button id>, label, reason, priority, score?}
   *   {kind:'wait',  reason}        nothing safe/legal to do right now
   *   {kind:'pause', reason}        bot must stop and ask the human
   *   {kind:'none',  reason}        no actionable buttons
   * plus `advisory`: list of non-executable recommendations (builds, trades, liquidation).
   */
  function selectAction(ctx) {
    console.log("Buttons in selectAction:", ctx.buttons);
    const cfg = ctx.cfg, s = ctx.state, v = ctx.validation || validateState(s);
    const advisory = [];
    const usable = (ctx.buttons || []).filter(function (b) { return b.enabled && b.visible; });
    const of = function (kind) { return usable.filter(function (b) { return b.kind === kind; }); };
    // Never click when multiple buttons match the same intent.
    const one = function (kind, why) {
      const m = of(kind);
      if (m.length === 1) return { ok: true, b: m[0] };
      if (m.length > 1) return { ok: false, reason: 'ambiguous: ' + m.length + ' "' + kind + '" buttons' };
      return { ok: false, reason: 'no ' + kind + ' button' };
    };
    const click = function (b, reason, priority, extra) {
      return Object.assign({ kind: 'click', target: b.id, label: b.text, reason: reason, priority: priority, advisory: advisory }, extra || {});
    };
    const wait = function (reason) { return { kind: 'wait', reason: reason, advisory: advisory }; };

    if (!usable.length) return { kind: 'none', reason: 'no enabled buttons visible', advisory: advisory };

    const level = v.level;
    const me = s && s.players ? getMe(s) : null;

    // P0: dismiss mandatory prompts
    if (of('confirm').length) {
      const r = one('confirm');
      return r.ok ? click(r.b, 'dismiss prompt', 0) : wait(r.reason);
    }

    // P1: incoming trade
    if (of('accept_trade').length || of('decline_trade').length) {
      const tr = s && s.pending ? s.pending.trade : null;
      const acc = one('accept_trade'), dec = one('decline_trade');
      if (tr && level !== 'unusable') {
        const ev = evaluateTrade(s, cfg, tr);
        if (ev.action === 'accept') return acc.ok ? click(acc.b, 'accept trade: ' + ev.reason, 1, { score: ev.delta }) : wait(acc.reason);
        return dec.ok ? click(dec.b, 'decline trade: ' + ev.reason, 1, { score: ev.delta }) : wait(dec.reason);
      }
      if (cfg.unknownTradePolicy === 'decline' && dec.ok) return click(dec.b, 'decline trade: terms unreadable (policy)', 1);
      return { kind: 'pause', reason: 'trade offer visible but terms unreadable', advisory: advisory };
    }

    // P2: jail prompt
    if (of('jail_pay').length || of('jail_card').length) {
      const payB = of('jail_pay')[0] || null, cardB = of('jail_card')[0] || null, rollB = of('roll')[0] || null;
      if (of('jail_pay').length > 1 || of('jail_card').length > 1) return wait('ambiguous jail buttons');
      const d = decideJail(s || { players: [], squares: [], meId: null, pending: {}, bank: {} }, cfg,
        { fee: payB ? payB.price : null, hasCard: !!cardB, canRoll: !!rollB });
      if (d.action === 'card' && cardB) return click(cardB, 'jail: ' + d.reason, 2);
      if (d.action === 'pay' && payB) return click(payB, 'jail: ' + d.reason, 2);
      if (d.action === 'roll' && rollB) return click(rollB, 'jail: ' + d.reason, 2);
      return wait('jail: ' + d.reason);
    }

    // P3: purchase prompt
    if (of('buy').length) {
      const b = one('buy');
      if (!b.ok) return wait(b.reason);
      if (level === 'unusable' || level === 'degraded' || !me || !isNum(me.cash)) {
        if (cfg.degradedPolicy === 'decline') {
          const alt = of('dont_buy')[0] || of('auction')[0] || of('pass')[0];
          if (alt) return click(alt, 'purchase not evaluable (' + (v.fatal.concat(v.warnings).join(', ') || 'state incomplete') + '): declining by policy', 3);
        }
        return { kind: 'pause', reason: 'purchase decision needs readable cash/board state (' + (v.fatal.concat(v.warnings).join(', ')) + ')', advisory: advisory };
      }
      const d = decidePurchase(s, cfg, { squareId: s.pending.purchase ? s.pending.purchase.squareId : null, price: b.b.price });
      if (d.action === 'buy') return click(b.b, 'buy: ' + d.reason, 3, { score: d.score });
      const alt = of('dont_buy')[0] || of('auction')[0] || of('pass')[0];
      if (d.action === 'decline' && alt) return click(alt, 'decline purchase: ' + d.reason, 3, { score: d.score });
      // If we want to decline but there's no explicit decline button, we should end the turn if possible.
      const endBtn = of('end_turn')[0];
      if (endBtn) {
        return click(endBtn, 'decline purchase: ending turn instead', 3, { score: d.score });
      }
      // Otherwise, we have to wait for a proper decline button.
      return wait('wanted to decline purchase (' + d.reason + ') but no unambiguous decline/auction/pass button');
    }

    // Advisory work (cannot be executed without a verified property UI)
    if (level === 'full' && me) {
      const pay = s.pending.payment;
      if (pay && isNum(pay.amount) && isNum(me.cash) && pay.amount > me.cash) {
        const lp = planLiquidation(s, cfg, pay.amount);
        advisory.push({ type: 'liquidate', plan: lp });
      }
      const bd = decideBuild(s, cfg);
      if (bd.action === 'build') advisory.push({ type: 'build', best: bd.best, reason: bd.reason });
      proposeTrades(s, cfg).slice(0, 2).forEach(function (p) { advisory.push({ type: 'propose-trade', proposal: p }); });
    }

    // P4: roll
    if (of('roll').length) {
      const r = one('roll');
      return r.ok ? click(r.b, 'roll dice', 4) : wait(r.reason);
    }

    // P5/P6: end turn (after optional development, which is advisory-only)
    if (of('end_turn').length) {
      const r = one('end_turn');
      return r.ok ? click(r.b, 'end turn', 6) : wait(r.reason);
    }

    if (of('concede').length && cfg.allowConcede && level === 'full' && me && isNum(me.cash)) {
      const lp = s.pending.payment && isNum(s.pending.payment.amount) ? planLiquidation(s, cfg, s.pending.payment.amount) : null;
      if (lp && lp.solvent === false) { const r = one('concede'); if (r.ok) return click(r.b, 'concede: ' + lp.reason, 0); }
    }
    return wait('no actionable button matched current priorities');
  }

  // ------------------------------------------------------------------
  // Action gate: duplicate prevention, one-in-flight, verification, stall detection
  // ------------------------------------------------------------------
  function createActionGate(cfg, nowFn) {
    const now = nowFn || function () { return Date.now(); };
    const g = {
      inFlight: null,
      lastKeyAt: {},
      fails: {},
      stalled: false,
      stallReason: null,
      lastIssuedVersion: -1
    };
    g.isStale = function (snapshotMeta, fingerprint) {
      if (!snapshotMeta || !isNum(snapshotMeta.capturedAt) || snapshotMeta.capturedAt <= 0) return { stale: true, reason: 'no capture time' };
      if (now() - snapshotMeta.capturedAt > cfg.maxStateAgeMs) return { stale: true, reason: 'snapshot older than ' + cfg.maxStateAgeMs + 'ms' };
      if (g.inFlight && snapshotMeta.version <= g.lastIssuedVersion && fingerprint === g.inFlight.fingerprint)
        return { stale: true, reason: 'no new snapshot since last action' };
      return { stale: false };
    };
    g.canIssue = function (kind, target, fingerprint) {
      if (g.stalled) return { ok: false, reason: 'gate stalled: ' + g.stallReason };
      if (g.inFlight) return { ok: false, reason: 'action in flight: ' + g.inFlight.kind };
      const key = kind + '|' + target + '|' + fingerprint;
      const last = g.lastKeyAt[key];
      if (last != null && now() - last < cfg.duplicateCooldownMs) return { ok: false, reason: 'duplicate within cooldown' };
      return { ok: true, key: key };
    };
    g.markIssued = function (kind, target, fingerprint, version) {
      const key = kind + '|' + target + '|' + fingerprint;
      g.inFlight = { kind: kind, target: target, fingerprint: fingerprint, key: key, at: now() };
      g.lastKeyAt[key] = now();
      g.lastIssuedVersion = isNum(version) ? version : g.lastIssuedVersion;
    };
    /** Compare current fingerprint to the pre-action one. */
    g.observe = function (fingerprint) {
      if (!g.inFlight) return { status: 'idle' };
      if (fingerprint !== g.inFlight.fingerprint) {
        const k = g.inFlight.key;
        g.inFlight = null;
        g.fails[k] = 0;
        return { status: 'confirmed' };
      }
      if (now() - g.inFlight.at > cfg.actionVerifyTimeoutMs) {
        const k = g.inFlight.key;
        g.fails[k] = (g.fails[k] || 0) + 1;
        const info = g.inFlight;
        g.inFlight = null;
        delete g.lastKeyAt[k];          // allow a retry, but fail count caps it
        if (g.fails[k] >= cfg.maxRetries) {
          g.stalled = true;
          g.stallReason = info.kind + ' had no visible effect after ' + g.fails[k] + ' attempts';
          return { status: 'stalled', reason: g.stallReason };
        }
        return { status: 'timeout', attempts: g.fails[k] };
      }
      return { status: 'waiting' };
    };
    g.reset = function () { g.inFlight = null; g.lastKeyAt = {}; g.fails = {}; g.stalled = false; g.stallReason = null; };
    return g;
  }

  // ------------------------------------------------------------------
  // Fingerprints, diffs (observation logging), sanitization
  // ------------------------------------------------------------------
  function fingerprint(s, buttons) {
    const b = (buttons || []).filter(function (x) { return x.enabled && x.visible; })
      .map(function (x) { return x.kind + ':' + x.text; }).sort().join('|');
    const me = s && s.players ? getMe(s) : null;
    const pl = s && s.players ? s.players.map(function (p) { return [p.id, p.cash, p.position, p.inJail, p.bankrupt].join(','); }).join(';') : '';
    const sq = s && s.squares ? s.squares.map(function (q) { return [q.owner, q.houses, q.mortgaged].join(','); }).join(';') : '';
    return hash(b + '#' + pl + '#' + sq + '#' + (me ? me.id : ''));
  }
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /** Observable events between two snapshots (used to log what built-in bots/opponents did). */
  function diffStates(prev, next) {
    const ev = [];
    if (!prev || !next) return ev;
    next.players.forEach(function (p) {
      const o = getPlayer(prev, p.id);
      if (!o) return;
      if (isNum(o.cash) && isNum(p.cash) && o.cash !== p.cash) ev.push({ type: 'cash', player: p.id, delta: p.cash - o.cash });
      if (isNum(o.position) && isNum(p.position) && o.position !== p.position) ev.push({ type: 'move', player: p.id, from: o.position, to: p.position });
      if (o.inJail !== p.inJail && p.inJail != null) ev.push({ type: p.inJail ? 'jailed' : 'released', player: p.id });
      if (o.bankrupt !== true && p.bankrupt === true) ev.push({ type: 'bankrupt', player: p.id });
    });
    next.squares.forEach(function (q) {
      const o = sqById(prev, q.id);
      if (!o) return;
      if (o.owner !== q.owner && o.owner !== undefined && q.owner !== undefined) ev.push({ type: 'owner', square: q.id, from: o.owner, to: q.owner });
      if (lvl(o) !== lvl(q) && o.houses != null && q.houses != null) ev.push({ type: lvl(q) > lvl(o) ? 'build' : 'sell-building', square: q.id, from: lvl(o), to: lvl(q) });
      if (o.mortgaged !== q.mortgaged && q.mortgaged != null && o.mortgaged != null) ev.push({ type: q.mortgaged ? 'mortgage' : 'unmortgage', square: q.id });
    });
    return ev;
  }

  /** Strip names and other free-text identifiers so a dump is safe to share. */
  function sanitizeState(s) {
    if (!s) return null;
    const t = clone(s);
    const map = {};
    t.players.forEach(function (p, i) { map[p.id] = 'P' + (i + 1); });
    t.players.forEach(function (p) { p.id = map[p.id]; p.name = p.id === map[s.meId] ? 'ME' : p.id; });
    t.meId = t.meId ? map[t.meId] || null : null;
    t.currentPlayerId = t.currentPlayerId ? map[t.currentPlayerId] || null : null;
    t.squares.forEach(function (q) { if (typeof q.owner === 'string') q.owner = map[q.owner] || 'unknown'; });
    if (t.pending && t.pending.trade) t.pending.trade = '[trade object omitted]';
    return t;
  }

  /** Structural description of an arbitrary object (keys and types, values redacted) for debugging dumps. */
  const KEEP_STRING_KEYS = /^(type|kind|group|color|colour|phase|state|status|action|category)$/i;
  function shapeOf(v, depth, key, seen) {
    depth = depth == null ? 4 : depth;
    seen = seen || new Set();
    if (v === null) return null;
    const t = typeof v;
    if (t === 'number') return v;
    if (t === 'boolean') return v;
    if (t === 'string') return KEEP_STRING_KEYS.test(key || '') && v.length <= 24 ? v : '<string:' + v.length + '>';
    if (t === 'function') return '<fn>';
    if (t === 'undefined') return '<undefined>';
    if (t !== 'object') return '<' + t + '>';
    if (seen.has(v)) return '<circular>';
    if (depth <= 0) return Array.isArray(v) ? '<array:' + v.length + '>' : '<object>';
    seen.add(v);
    let out;
    if (Array.isArray(v)) {
      out = { __array: v.length, sample: v.slice(0, 2).map(function (x) { return shapeOf(x, depth - 1, key, seen); }) };
    } else {
      out = {};
      Object.keys(v).slice(0, 40).forEach(function (k) {
        try { out[k] = shapeOf(v[k], depth - 1, k, seen); } catch (e) { out[k] = '<unreadable>'; }
      });
    }
    seen.delete(v);
    return out;
  }

  // ------------------------------------------------------------------
  // Raw -> normalized mapping (alias guesses; UNVERIFIED against Richup.io)
  // ------------------------------------------------------------------
  const ALIASES = {
    top: {
      players: ['players', 'users', 'participants'],
      squares: ['squares', 'board', 'cells', 'tiles', 'properties', 'fields'],
      me: ['myId', 'meId', 'selfId', 'userId', 'playerId', 'currentUserId'],
      current: ['currentPlayerId', 'currentPlayer', 'turnPlayerId', 'turn', 'activePlayerId']
    },
    player: {
      id: ['id', '_id', 'playerId', 'userId', 'uid', 'key'],
      name: ['name', 'nickname', 'username', 'displayName', 'nick'],
      cash: ['money', 'cash', 'balance', 'funds', 'wallet'],
      position: ['position', 'pos', 'location', 'boardPosition', 'cellIndex', 'tileIndex', 'squareIndex'],
      bankrupt: ['bankrupt', 'isBankrupt', 'eliminated', 'isEliminated', 'lost'],
      inJail: ['inJail', 'isInJail', 'jailed', 'isJailed'],
      jailTurns: ['jailTurns', 'turnsInJail', 'jailTurn', 'jailCount'],
      pardonCards: ['pardonCards', 'jailCards', 'getOutOfJailCards', 'freeCards'],
      isBot: ['isBot', 'bot', 'ai', 'isAI', 'isComputer']
    },
    square: {
      id: ['id', '_id', 'key', 'index'],
      index: ['index', 'position', 'pos', 'cell'],
      name: ['name', 'title', 'label'],
      type: ['type', 'kind', 'category'],
      group: ['group', 'color', 'colour', 'set', 'colorGroup'],
      price: ['price', 'cost', 'value', 'purchasePrice'],
      rents: ['rents', 'rent', 'rentSchedule', 'rentPrices'],
      houseCost: ['houseCost', 'housePrice', 'buildCost', 'buildingCost'],
      mortgageValue: ['mortgageValue', 'mortgage', 'mortgagePrice'],
      owner: ['owner', 'ownerId', 'ownedBy', 'playerId'],
      houses: ['houses', 'level', 'buildings', 'houseCount', 'buildingLevel'],
      mortgaged: ['mortgaged', 'isMortgaged']
    }
  };
  function pick(obj, names) {
    if (!obj || typeof obj !== 'object') return { value: undefined, key: null };
    for (let i = 0; i < names.length; i++) if (obj[names[i]] !== undefined) return { value: obj[names[i]], key: names[i] };
    return { value: undefined, key: null };
  }
  function mapType(t) {
    const x = String(t == null ? '' : t).toLowerCase();
    if (/rail|station|airport|transport/.test(x)) return 'railroad';
    if (/util|company|electric|water/.test(x)) return 'utility';
    if (/tax/.test(x)) return 'tax';
    if (/jail|prison/.test(x)) return 'jail';
    if (/street|property|city|estate|land|country/.test(x)) return 'street';
    return x || 'other';
  }
  /** Convert a raw game object into the engine schema and report which source keys were used. */
  function fromRaw(raw) {
    const report = { players: {}, squares: {}, top: {}, unmapped: [] };
    const top = {};
    Object.keys(ALIASES.top).forEach(function (k) { const r = pick(raw, ALIASES.top[k]); top[k] = r.value; report.top[k] = r.key; });
    const rawPlayers = Array.isArray(top.players) ? top.players : [];
    const rawSquares = Array.isArray(top.squares) ? top.squares : [];
    const players = rawPlayers.map(function (rp, i) {
      const o = {};
      Object.keys(ALIASES.player).forEach(function (k) { const r = pick(rp, ALIASES.player[k]); o[k] = r.value; if (r.key) report.players[k] = r.key; });
      if (o.id === undefined) o.id = 'p' + i;
      return o;
    });
    const squares = rawSquares.map(function (rs, i) {
      const o = {};
      Object.keys(ALIASES.square).forEach(function (k) { const r = pick(rs, ALIASES.square[k]); o[k] = r.value; if (r.key) report.squares[k] = r.key; });
      o.type = mapType(o.type);
      if (o.index === undefined || !isNum(o.index)) o.index = i;
      if (o.id === undefined) o.id = 's' + i;
      if (typeof o.owner === 'object' && o.owner && o.owner.id !== undefined) o.owner = o.owner.id;
      if (!Array.isArray(o.rents)) o.rents = isNum(o.rents) ? [o.rents] : null;
      if (typeof o.houses === 'object') o.houses = undefined;
      return o;
    });
    // Ownership derived from per-player property lists (common shape). Only trust "unowned" when EVERY player exposes a list.
    const OWNED_KEYS = ['properties', 'ownedProperties', 'owned', 'estates', 'assets', 'ownedSquares', 'ownedCells'];
    let listsSeen = 0;
    rawPlayers.forEach(function (rp, i) {
      const r = pick(rp, OWNED_KEYS);
      if (!Array.isArray(r.value)) return;
      listsSeen++;
      report.players.ownedList = r.key;
      r.value.forEach(function (item) {
        const key = item && typeof item === 'object' ? (item.id !== undefined ? item.id : item.index) : item;
        const sq = squares.find(function (q) { return String(q.id) === String(key) || (isNum(key) && q.index === key); });
        if (sq && sq.owner === undefined) sq.owner = players[i].id;
      });
    });
    if (rawPlayers.length && listsSeen === rawPlayers.length) {
      squares.forEach(function (q) {
        if (q.owner === undefined && (q.type === 'street' || q.type === 'railroad' || q.type === 'utility')) q.owner = null;
      });
    }
    const cur = top.current && typeof top.current === 'object' ? (top.current.id !== undefined ? top.current.id : null) : top.current;
    const state = normalizeState({ players: players, squares: squares, meId: top.me, currentPlayerId: cur, meta: { source: 'raw' } });
    ['players', 'squares'].forEach(function (k) { if (!report.top[k]) report.unmapped.push(k); });
    return { state: state, report: report };
  }

  // ------------------------------------------------------------------
  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG, mergeConfig: mergeConfig,
    normalizeState: normalizeState, validateState: validateState, fromRaw: fromRaw,
    classifyButton: classifyButton, selectAction: selectAction,
    decidePurchase: decidePurchase, decideBuild: decideBuild, decideJail: decideJail,
    evaluateTrade: evaluateTrade, proposeTrades: proposeTrades, planLiquidation: planLiquidation,
    computeReserve: computeReserve, computeThreat: computeThreat, positionValue: positionValue, standing: standing,
    createActionGate: createActionGate, fingerprint: fingerprint, diffStates: diffStates,
    sanitizeState: sanitizeState, shapeOf: shapeOf, ALIASES: ALIASES,
    helpers: { getMe: getMe, getPlayer: getPlayer, hasMonopoly: hasMonopoly, sqById: sqById, num: num, clone: clone, p2d6: p2d6 }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RichupEngine;

/* =====================================================================
 * Browser runtime. Everything below touches the page.
 *
 * VERIFICATION STATUS (important):
 *  - The author could NOT load Richup.io while writing this. Button texts marked [ref1] in the engine
 *    come from Reference 1; the framework-state discovery (React/Vue) is a generic shape search.
 *    None of it is verified against the live site. Use "Probe" and "Dump state" first.
 *  - Default mode is DRY-RUN: decisions are evaluated and logged, nothing is clicked.
 * ===================================================================== */
const Engine = RichupEngine;
const BOT_VERSION = '0.1.0';
const HOST_ID = 'rsb-host';
const LS_KEY = 'richupStrategicBot.settings.v1';
const LOG_MAX = 80;
const OBS_MAX = 400;

if (window.__richupStrategicBot && typeof window.__richupStrategicBot.cleanup === 'function') {
  try { window.__richupStrategicBot.cleanup(); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------
// Settings (persisted in localStorage; failures are non-fatal)
// ---------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  dryRun: true, manualStep: false, learningLog: false, myName: '',
  actionDelayMs: 400,
  reserveBase: 150, riskTolerance: 0.5, purchaseAggressiveness: 0.5, developmentAggressiveness: 0.5,
  collapsed: false, posX: null, posY: null
};
function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
  catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
const settings = loadSettings();
function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } }
function engineCfg() {
  return Engine.mergeConfig({
    reserveBase: settings.reserveBase, riskTolerance: settings.riskTolerance,
    purchaseAggressiveness: settings.purchaseAggressiveness, developmentAggressiveness: settings.developmentAggressiveness
  });
}

// ---------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------
const rt = {
  running: false, busy: false, destroyed: false,
  stopReason: null, phase: 'idle',
  timers: new Set(), tickTimer: null, watchdog: null, observer: null, hostObserver: null, uiTimer: null,
  gate: Engine.createActionGate(engineCfg()),
  version: 0, lastSnap: null, prevState: null, lastDryKey: null, lastManualKey: null, lastGateMsg: null,
  pendingManual: null, lastDecision: null, errors: 0,
  buttonEls: new Map(), fw: { at: 0, found: null },
  log: [], obs: [], lastProbe: null, uiDirty: false, keyHandler: null
};

function later(fn, ms) {
  const id = setTimeout(function () { rt.timers.delete(id); if (!rt.destroyed) fn(); }, ms);
  rt.timers.add(id);
  return id;
}
function clearTimers() {
  rt.timers.forEach(function (id) { clearTimeout(id); });
  rt.timers.clear();
  rt.tickTimer = null; rt.uiTimer = null; rt.uiDirty = false;     // a cancelled UI timer must not leave the dirty flag stuck
  if (rt.watchdog) { clearInterval(rt.watchdog); rt.watchdog = null; }
  if (rt.observer) { rt.observer.disconnect(); rt.observer = null; }
}

function log(msg, level) {
  rt.log.push({ t: Date.now(), level: level || 'info', msg: String(msg) });
  if (rt.log.length > LOG_MAX) rt.log.shift();
  try { console.log('[RichupBot] ' + msg); } catch (e) { /* ignore */ }
  uiDirty();
}

// ---------------------------------------------------------------------
// Reader 1: buttons (DOM)
// ---------------------------------------------------------------------
function isVisible(el) {
  try {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch (e) { return false; }
}
function isEnabled(el) {
  if (el.disabled) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  try { if (getComputedStyle(el).pointerEvents === 'none') return false; } catch (e) { /* ignore */ }
  return true;
}
function readButtons() {
  rt.buttonEls.clear();
  const out = [];
  let i = 0;
  document.querySelectorAll('button,[role="button"]').forEach(function (el) {
    if (el.closest('#' + HOST_ID)) return;                                   // never read our own panel
    const outer = el.parentElement ? el.parentElement.closest('button,[role="button"]') : null;
    if (outer) return;                                                       // nested control: count the outer one only
    const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60) return;
    const c = Engine.classifyButton(text);
    const id = 'b' + (i++);
    rt.buttonEls.set(id, el);
    out.push({ id: id, kind: c.kind, price: c.price, text: c.text, enabled: isEnabled(el), visible: isVisible(el) });
  });
  return out;
}

// ---------------------------------------------------------------------
// Reader 2: framework state discovery (React fibers / Vue 3 instances).
// UNVERIFIED shape search: looks for an array of 2-12 objects that each carry a numeric cash-like field.
// Read-only. Bounded by node count, depth and a time budget.
// ---------------------------------------------------------------------
const FW = (function () {
  const MAX_FIBERS = 40000, MAX_DEPTH = 5, MAX_KEYS = 60, TIME_BUDGET_MS = 150, MIN_INTERVAL_MS = 700;
  const A = Engine.ALIASES;

  function isHostObj(o) {
    try { return (typeof Node !== 'undefined' && o instanceof Node) || o === window || (typeof Window !== 'undefined' && o instanceof Window); }
    catch (e) { return false; }
  }
  function looksLikePlayers(arr) {
    if (!Array.isArray(arr) || arr.length < 2 || arr.length > 12) return 0;
    let score = 0;
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i];
      if (!x || typeof x !== 'object') return 0;
      if (!A.player.cash.some(function (k) { return typeof x[k] === 'number'; })) return 0;
      score += 1;
      if (A.player.name.some(function (k) { return typeof x[k] === 'string'; })) score += 1;
      if (A.player.id.some(function (k) { return x[k] !== undefined; })) score += 1;
      if (A.player.position.some(function (k) { return typeof x[k] === 'number'; })) score += 1;
    }
    return score / arr.length;
  }
  function looksLikeSquares(arr) {
    if (!Array.isArray(arr) || arr.length < 20 || arr.length > 80) return 0;
    let priced = 0, objs = 0;
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i];
      if (x && typeof x === 'object') {
        objs++;
        if (A.square.price.some(function (k) { return typeof x[k] === 'number'; })) priced++;
      }
    }
    return objs >= arr.length * 0.7 && priced >= arr.length * 0.3 ? priced : 0;
  }

  function scan(obj, acc, depth, seen, container) {
    if (acc.done || !obj || typeof obj !== 'object' || seen.has(obj) || isHostObj(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) {
      const ps = looksLikePlayers(obj);
      if (ps) { acc.players.push({ arr: obj, score: ps, container: container }); return; }
      const qs = looksLikeSquares(obj);
      if (qs) { acc.squares.push({ arr: obj, score: qs, container: container }); return; }
      if (depth > 0) for (let i = 0; i < Math.min(obj.length, 6); i++) scan(obj[i], acc, depth - 1, seen, container);
      return;
    }
    if (typeof Map !== 'undefined' && obj instanceof Map) {
      if (depth > 0) { let n = 0; obj.forEach(function (v) { if (n++ < 20) scan(v, acc, depth - 1, seen, container); }); }
      return;
    }
    let keys;
    try { keys = Object.keys(obj); } catch (e) { return; }
    if (keys.length > MAX_KEYS) keys = keys.slice(0, MAX_KEYS);
    keys.forEach(function (k) {
      let v;
      try { v = obj[k]; } catch (e) { return; }
      if (A.top.me.indexOf(k) >= 0 && (typeof v === 'string' || typeof v === 'number')) acc.hints.push({ container: obj, kind: 'me', value: v });
      if (A.top.current.indexOf(k) >= 0 && (typeof v === 'string' || typeof v === 'number')) acc.hints.push({ container: obj, kind: 'current', value: v });
    });
    keys.forEach(function (k) {
      let v;
      try { v = obj[k]; } catch (e) { return; }
      if (v && typeof v === 'object' && (depth > 0 || Array.isArray(v))) scan(v, acc, depth - 1, seen, obj);
    });
  }

  function reactRoots() {
    const out = new Set();
    const cands = [document.getElementById('__next'), document.getElementById('root'), document.getElementById('app'), document.body]
      .concat(Array.prototype.slice.call(document.body ? document.body.children : [], 0, 8));
    cands.forEach(function (el) {
      if (!el) return;
      let keys; try { keys = Object.keys(el); } catch (e) { return; }
      keys.forEach(function (k) {
        if (k.indexOf('__reactContainer$') === 0 || k.indexOf('__reactFiber$') === 0) {
          let f = el[k]; if (!f) return;
          let g = 0; while (f.return && g++ < 10000) f = f.return;
          out.add(f);
        }
      });
      if (el._reactRootContainer && el._reactRootContainer._internalRoot && el._reactRootContainer._internalRoot.current) out.add(el._reactRootContainer._internalRoot.current);
    });
    return Array.from(out);
  }
  function walkFibers(root, acc, seen) {
    const stack = [root]; const t0 = performance.now(); let n = 0;
    while (stack.length && n < MAX_FIBERS) {
      const f = stack.pop(); n++;
      if ((n & 255) === 0 && performance.now() - t0 > TIME_BUDGET_MS) { acc.truncated = true; break; }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
      try {
        scan(f.memoizedProps, acc, MAX_DEPTH, seen, null);
        let h = f.memoizedState, g = 0;
        while (h && typeof h === 'object' && g++ < 40) {
          if ('next' in h && 'memoizedState' in h) { scan(h.memoizedState, acc, MAX_DEPTH, seen, null); h = h.next; }
          else { scan(h, acc, MAX_DEPTH, seen, null); break; }
        }
      } catch (e) { /* keep walking */ }
    }
    acc.fibers += n;
  }

  function vueApps() {
    const out = [];
    ['#app', '[data-v-app]', '#__nuxt', '#root'].forEach(function (sel) {
      const el = document.querySelector(sel);
      if (el && el.__vue_app__ && out.indexOf(el.__vue_app__) < 0) out.push(el.__vue_app__);
    });
    Array.prototype.slice.call(document.body ? document.body.children : []).forEach(function (el) {
      if (el.__vue_app__ && out.indexOf(el.__vue_app__) < 0) out.push(el.__vue_app__);
    });
    return out;
  }
  function walkVue(app, acc, seen) {
    try {
      const ctx = app._context;
      if (ctx) { scan(ctx.config && ctx.config.globalProperties, acc, 3, seen, null); scan(ctx.provides, acc, 4, seen, null); }
    } catch (e) { /* ignore */ }
    const stack = [app._instance && app._instance.subTree];
    const t0 = performance.now(); let n = 0;
    while (stack.length && n < MAX_FIBERS) {
      const vn = stack.pop(); n++;
      if (!vn) continue;
      if ((n & 255) === 0 && performance.now() - t0 > TIME_BUDGET_MS) { acc.truncated = true; break; }
      try {
        const inst = vn.component;
        if (inst) {
          scan(inst.setupState, acc, 3, seen, null); scan(inst.data, acc, 3, seen, null); scan(inst.props, acc, 3, seen, null);
          stack.push(inst.subTree);
        }
        if (Array.isArray(vn.children)) vn.children.forEach(function (c) { if (c && typeof c === 'object') stack.push(c); });
      } catch (e) { /* ignore */ }
    }
    acc.fibers += n;
  }

  function assemble(acc, origin) {
    const diag = { origin: origin, nodes: acc.fibers, truncated: acc.truncated, playerArrays: acc.players.length, squareArrays: acc.squares.length };
    if (!acc.players.length) return { raw: null, origin: origin, diag: diag };
    acc.players.sort(function (a, b) { return b.score - a.score || b.arr.length - a.arr.length; });
    const P = acc.players[0];
    let Q = acc.squares.filter(function (q) { return P.container && q.container === P.container; })[0];
    if (!Q) { acc.squares.sort(function (a, b) { return b.score - a.score; }); Q = acc.squares[0]; }
    const raw = { players: P.arr, squares: Q ? Q.arr : [] };
    acc.hints.forEach(function (h) {
      if (P.container && h.container !== P.container) return;
      if (h.kind === 'me' && raw.myId === undefined) raw.myId = h.value;
      if (h.kind === 'current' && raw.currentPlayerId === undefined) raw.currentPlayerId = h.value;
    });
    diag.playersFound = P.arr.length; diag.squaresFound = Q ? Q.arr.length : 0; diag.sameContainer = !!(Q && P.container && Q.container === P.container);
    diag.hasMeHint = raw.myId !== undefined; diag.hasCurrentHint = raw.currentPlayerId !== undefined;
    return { raw: raw, origin: origin, diag: diag };
  }

  function read(force) {
    const now = Date.now();
    if (!force && rt.fw.found && now - rt.fw.at < MIN_INTERVAL_MS) return rt.fw.found;
    const acc = { players: [], squares: [], hints: [], truncated: false, fibers: 0, done: false };
    const seen = new Set();
    let origin = 'none';
    try {
      const roots = reactRoots();
      if (roots.length) { origin = 'react'; roots.forEach(function (r) { walkFibers(r, acc, seen); }); }
      if (!acc.players.length) {
        const apps = vueApps();
        if (apps.length) { origin = 'vue'; apps.forEach(function (a) { walkVue(a, acc, seen); }); }
      }
    } catch (e) { origin = 'error:' + e.message; }
    const found = assemble(acc, origin);
    rt.fw = { at: now, found: found };
    return found;
  }
  return { read: read };
})();

// ---------------------------------------------------------------------
// Snapshot builder: raw page -> normalized, validated, fingerprinted state
// ---------------------------------------------------------------------
function buildSnapshot(forceDiscover) {
  rt.version++;
  const buttons = readButtons();
  const found = FW.read(!!forceDiscover);
  let state, mapping = null;
  if (found.raw) {
    const m = Engine.fromRaw(found.raw);
    state = m.state; mapping = m.report;
  } else {
    state = Engine.normalizeState({});
  }
  // Identify "me": explicit hint > configured name > inferred from turn buttons (flagged).
  let meNote = null;

  // Try to get meId from settings.myName
  const name = String(settings.myName || '').trim().toLowerCase();
  let meIdFromName = null;
  if (name) {
    const p = state.players.filter(function (x) { return x.name.trim().toLowerCase() === name; });
    if (p.length === 1) {
      meIdFromName = p[0].id;
    }
  }

  // Try to get meId from currentPlayerId (if we see a roll or end_turn button for the current player)
  let meIdFromCurrent = null;
  if (!meIdFromName && state.currentPlayerId && buttons.some(function (b) { return b.enabled && b.visible && (b.kind === 'roll' || b.kind === 'end_turn'); })
      && Engine.helpers.getPlayer(state, state.currentPlayerId)) {
    meIdFromCurrent = state.currentPlayerId;
  }

  // Decide on the final meId
  let chosenMeId = null;
  let chosenMeNote = null;
  if (meIdFromName !== null) {
    chosenMeId = meIdFromName;
    chosenMeNote = 'by name';
  } else if (meIdFromCurrent !== null) {
    chosenMeId = meIdFromCurrent;
    chosenMeNote = 'inferred from turn buttons';
  } else {
    // No hints, keep the fiber's meId if it is set and valid
    if (state.meId && Engine.helpers.getPlayer(state, state.meId)) {
      chosenMeId = state.meId;
      // chosenMeNote remains null
    } else {
      chosenMeId = null;
      chosenMeNote = null;
    }
  }

  state.meId = chosenMeId;
  meNote = chosenMeNote;
  const buy = buttons.filter(function (b) { return b.kind === 'buy' && b.visible && b.enabled; })[0];
  if (buy && buy.price != null) state.pending.purchase = { squareId: null, price: buy.price };
  state.meta = { source: found.origin, capturedAt: Date.now(), version: rt.version };
  const validation = Engine.validateState(state);
  return { state: state, validation: validation, buttons: buttons, fp: Engine.fingerprint(state, buttons),
           version: rt.version, t: state.meta.capturedAt, origin: found.origin, diag: found.diag, mapping: mapping, meNote: meNote, raw: found.raw };
}

function isLobby(snap) {
  return snap.buttons.some(function (b) { return b.kind === 'lobby_marker' && b.visible; });
}

// ---------------------------------------------------------------------
// Probe + dump (debug tooling; sanitized)
// ---------------------------------------------------------------------
function probe() {
  const snap = buildSnapshot(true);
  let ws = [];
  try {
    ws = performance.getEntriesByType('resource').map(function (e) { try { const u = new URL(e.name); return u.origin + u.pathname; } catch (x) { return ''; } })
      .filter(function (n) { return /socket|ws|wss|realtime|poll/i.test(n); }).slice(0, 8);
  } catch (e) { /* ignore */ }
  const btnTexts = Array.from(new Set(snap.buttons.filter(function (b) { return b.visible; }).map(function (b) { return b.kind + ' :: ' + b.text; }))).slice(0, 60);
  rt.lastProbe = {
    at: new Date().toISOString(),
    framework: { origin: snap.origin, diag: snap.diag },
    globals: { windowIo: typeof window.io, nextData: typeof window.__NEXT_DATA__, vueApp: !!document.querySelector('[data-v-app]') },
    transportHints: ws,
    stateQuality: snap.validation, meIdentified: !!snap.state.meId, meNote: snap.meNote,
    fieldMapping: snap.mapping,
    visibleButtons: btnTexts
  };
  return { snap: snap, report: rt.lastProbe };
}

function makeDump() {
  const p = probe();
  return {
    tool: 'richup-strategic-bot', version: BOT_VERSION, generatedAt: new Date().toISOString(),
    page: location.origin + location.pathname.replace(/[0-9a-f-]{8,}/gi, '<id>'),
    note: 'Names and ids sanitized; raw structure shown as keys/types only. Safe to share for debugging.',
    probe: p.report,
    state: Engine.sanitizeState(p.snap.state),
    rawShape: p.snap.raw ? Engine.shapeOf(p.snap.raw, 5) : null,
    buttons: p.snap.buttons.map(function (b) { return { kind: b.kind, text: b.text, enabled: b.enabled, visible: b.visible }; }),
    settings: { dryRun: settings.dryRun, manualStep: settings.manualStep, reserveBase: settings.reserveBase, riskTolerance: settings.riskTolerance,
                purchaseAggressiveness: settings.purchaseAggressiveness, developmentAggressiveness: settings.developmentAggressiveness },
    recentLog: rt.log.slice(-30).map(function (l) { return l.level + ': ' + l.msg; })
  };
}

function download(filename, text) {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    later(function () { try { URL.revokeObjectURL(a.href); } catch (e) { /* ignore */ } }, 2000);
  } catch (e) { log('download failed: ' + e.message, 'error'); }
}
function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { log('copied to clipboard'); }, function () { log('clipboard blocked; use Download', 'warn'); }); }
  catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------
// Observation / learning log (Phase 7)
// ---------------------------------------------------------------------
function obsPush(entry) {
  entry.t = Date.now();
  rt.obs.push(entry);
  if (rt.obs.length > OBS_MAX) rt.obs.shift();
}
function compactState(s) {
  const san = Engine.sanitizeState(s);
  return {
    me: san.meId, phase: san.phase,
    players: san.players.map(function (p) { return { id: p.id, cash: p.cash, pos: p.position, jail: p.inJail, out: p.bankrupt }; }),
    owned: san.squares.filter(function (q) { return typeof q.owner === 'string'; }).map(function (q) { return [q.id, q.owner, q.houses, q.mortgaged]; }),
    pending: san.pending
  };
}
function observe(snap) {
  if (!settings.learningLog) { rt.prevState = snap.state; return; }
  if (rt.prevState && rt.prevState.meta && rt.prevState.meta.source === snap.state.meta.source) {
    const ev = Engine.diffStates(rt.prevState, snap.state);
    if (ev.length) obsPush({ kind: 'observed', events: ev });
  }
  rt.prevState = snap.state;
}
function recordDecision(snap, d, mode) {
  if (!settings.learningLog) return;
  obsPush({
    kind: 'decision', mode: mode, before: compactState(snap.state),
    legal: snap.buttons.filter(function (b) { return b.visible && b.enabled; }).map(function (b) { return b.kind + ':' + b.text; }),
    chosen: { kind: d.kind, label: d.label, reason: d.reason, score: d.score == null ? null : d.score, priority: d.priority },
    advisory: (d.advisory || []).map(function (a) { return a.type; })
  });
}
function recordResult(snap) {
  if (!settings.learningLog) return;
  obsPush({ kind: 'result', after: compactState(snap.state) });
}

// ---------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------
function describe(d) {
  if (!d) return 'idle';
  if (d.kind === 'click') return 'next: ' + d.label;
  return d.kind + ': ' + d.reason;
}
function requestTick(delay) {
  if (!rt.running || rt.destroyed) return;
  if (rt.tickTimer) { clearTimeout(rt.tickTimer); rt.timers.delete(rt.tickTimer); }
  rt.tickTimer = later(function () { rt.tickTimer = null; tick(); }, Math.max(0, delay || 0));
}
function tick() {
  if (!rt.running || rt.busy || rt.destroyed) return;
  try { runCycle(); rt.errors = 0; }
  catch (e) {
    rt.errors++; log('cycle error: ' + (e && e.message), 'error');
    if (rt.errors >= 5) stopBot('too many consecutive errors');
  }
}

function runCycle() {
  const snap = buildSnapshot(false);
  rt.lastSnap = snap; observe(snap); uiDirty();
  if (isLobby(snap)) { rt.phase = 'lobby: waiting for a game'; return; }

  if (rt.gate.inFlight) {
    const o = rt.gate.observe(snap.fp);
    if (o.status === 'waiting') { requestTick(250); return; }
    if (o.status === 'confirmed') { log('action confirmed: state changed'); recordResult(snap); }
    else if (o.status === 'timeout') log('no visible effect (attempt ' + o.attempts + '); re-evaluating', 'warn');
    else if (o.status === 'stalled') { stopBot('stalled: ' + o.reason); return; }
  }

  const decision = Engine.selectAction({ state: snap.state, validation: snap.validation, buttons: snap.buttons, cfg: engineCfg() });
  rt.lastDecision = decision; rt.phase = describe(decision);
  if (decision.advisory && decision.advisory.length) uiDirty();
  if (decision.kind === 'pause') { stopBot(decision.reason); return; }
  if (decision.kind !== 'click') return;                    // wait / none: mutation observer + watchdog will wake us

  const key = decision.label + '|' + snap.fp;
  if (settings.dryRun) {
    if (rt.lastDryKey !== key) { rt.lastDryKey = key; log('[DRY] would click "' + decision.label + '": ' + decision.reason, 'dry'); recordDecision(snap, decision, 'dry'); }
    return;
  }
  if (settings.manualStep) {
    rt.pendingManual = { decision: decision, fp: snap.fp };
    if (rt.lastManualKey !== key) { rt.lastManualKey = key; log('ready (manual): "' + decision.label + '": ' + decision.reason, 'info'); }
    return;
  }
  scheduleExecution(decision, snap);
}

function scheduleExecution(decision, snap) {
  const can = rt.gate.canIssue('click', decision.label, snap.fp);
  if (!can.ok) {
    if (rt.lastGateMsg !== can.reason) { rt.lastGateMsg = can.reason; log('gate: ' + can.reason); }
    requestTick(400);
    return;
  }
  rt.lastGateMsg = null;
  rt.busy = true;
  later(function () {
    rt.busy = false;
    if (!rt.running) return;
    executeFresh(decision, snap);
  }, Math.max(0, settings.actionDelayMs));
}

/** Re-read state, re-decide, and only click if the decision is unchanged. */
function executeFresh(prevDecision, prevSnap) {
  const fresh = buildSnapshot(true);
  rt.lastSnap = fresh;
  const d2 = Engine.selectAction({ state: fresh.state, validation: fresh.validation, buttons: fresh.buttons, cfg: engineCfg() });
  if (d2.kind !== 'click' || d2.label !== prevDecision.label || (prevSnap && fresh.fp !== prevSnap.fp)) {
    log('state changed before click; re-evaluating');
    requestTick(0);
    return false;
  }
  return doClick(d2, fresh);
}

function doClick(d, snap) {
  const can = rt.gate.canIssue('click', d.label, snap.fp);
  if (!can.ok) { log('gate: ' + can.reason); return false; }
  const el = rt.buttonEls.get(d.target);
  if (!el || !document.contains(el) || !isVisible(el) || !isEnabled(el)) { log('target button vanished or is disabled', 'warn'); requestTick(200); return false; }
  rt.gate.markIssued('click', d.label, snap.fp, snap.version);
  log('CLICK "' + d.label + '": ' + d.reason, 'act');
  recordDecision(snap, d, 'live');
  el.click();
  rt.pendingManual = null;
  requestTick(300);
  return true;
}

/** Manual-step: execute the currently proposed action once (after re-validation). */
function executePending() {
  if (!rt.pendingManual) { log('nothing pending', 'warn'); return; }
  if (settings.dryRun) { log('[DRY] manual execute skipped (dry-run is on)', 'dry'); return; }
  const pm = rt.pendingManual;
  rt.pendingManual = null;
  if (!executeFresh(pm.decision, { fp: pm.fp })) log('manual action discarded: state changed', 'warn');
}

function evaluateOnce() {
  const snap = buildSnapshot(true);
  rt.lastSnap = snap;
  const d = Engine.selectAction({ state: snap.state, validation: snap.validation, buttons: snap.buttons, cfg: engineCfg() });
  rt.lastDecision = d; rt.phase = describe(d);
  log('[EVAL] state=' + snap.validation.level + ' source=' + snap.origin + ' -> ' + describe(d) + (d.kind === 'click' ? ' (' + d.reason + ')' : ''), 'dry');
  (d.advisory || []).forEach(function (a) { log('[ADVISORY] ' + a.type + ': ' + (a.reason || (a.plan && a.plan.reason) || (a.proposal && a.proposal.note) || ''), 'dry'); });
  uiDirty();
  return d;
}

function startBot() {
  if (rt.running) return;
  rt.running = true; rt.stopReason = null; rt.errors = 0; rt.busy = false;
  rt.gate = Engine.createActionGate(engineCfg());
  rt.lastDryKey = null; rt.lastManualKey = null; rt.pendingManual = null;
  log('started (' + (settings.dryRun ? 'DRY-RUN' : settings.manualStep ? 'MANUAL-STEP' : 'LIVE') + ')');
  try {
    rt.observer = new MutationObserver(function () { if (rt.running && !rt.busy) requestTickDebounced(); });
    rt.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class'] });
  } catch (e) { log('observer failed: ' + e.message, 'error'); }
  rt.watchdog = setInterval(function () { if (rt.running && !rt.busy && !rt.tickTimer) requestTick(0); }, 2500);   // single controlled fallback timer
  requestTick(0);
  uiDirty();
}
let debounceId = null;
function requestTickDebounced() {
  if (debounceId) return;
  debounceId = later(function () { debounceId = null; requestTick(0); }, 150);
}
function stopBot(reason) {
  const was = rt.running;
  rt.running = false; rt.busy = false; rt.stopReason = reason || 'stopped by user'; rt.pendingManual = null;
  debounceId = null;
  clearTimers();
  rt.uiTimer = null;
  if (was) log('STOPPED: ' + rt.stopReason, reason ? 'warn' : 'info');
  uiDirty();
}

// ---------------------------------------------------------------------
// Panel (Shadow DOM). ALL game-derived text is inserted with textContent, never innerHTML.
// ---------------------------------------------------------------------
const UI = { host: null, root: null, els: {} };
function h(tag, props, kids) {
  const e = document.createElement(tag);
  if (props) Object.keys(props).forEach(function (k) {
    const v = props[k];
    if (k === 'text') e.textContent = String(v);
    else if (k === 'class') e.className = v;
    else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  });
  (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
  return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

const CSS = '\
:host{all:initial}*{box-sizing:border-box;font-family:ui-monospace,Consolas,Menlo,monospace}\
.p{position:fixed;top:12px;right:12px;width:330px;max-height:92vh;overflow:auto;background:#12151c;color:#dfe6ee;border:1px solid #2f3a4d;border-radius:8px;font-size:11.5px;line-height:1.4;box-shadow:0 6px 24px #000a;z-index:2147483647}\
.hd{display:flex;justify-content:space-between;align-items:center;padding:7px 9px;background:#1b2230;cursor:grab;user-select:none;border-bottom:1px solid #2f3a4d}\
.hd b{color:#8fd1ff;font-size:12px}.bd{padding:8px 9px;display:flex;flex-direction:column;gap:7px}.col .bd{display:none}\
.row{display:flex;gap:5px;flex-wrap:wrap;align-items:center}.row label{display:flex;gap:4px;align-items:center}\
button{background:#1d2a3d;color:#cfe8ff;border:1px solid #38506f;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px}button:hover{background:#27405f}\
button.go{background:#0f3b24;border-color:#2e8f5b;color:#b8ffd8}button.stop{background:#4a1820;border-color:#a23a4a;color:#ffd0d6}\
input[type=number],input[type=text]{background:#0b0e13;color:#9fe0ff;border:1px solid #334;border-radius:3px;padding:2px 4px;width:70px;font-size:11px}input[type=text]{width:110px}input[type=range]{width:90px}\
.st{padding:4px 6px;border-radius:4px;background:#0b0e13}.ok{color:#6dffa8}.warn{color:#ffd166}.bad{color:#ff7a8a}.dim{color:#8795a8}\
h4{margin:2px 0;color:#9db4d0;font-size:11px;letter-spacing:.5px;text-transform:uppercase}\
.box{background:#0b0e13;border:1px solid #232c3b;border-radius:4px;padding:4px 6px}.log{height:140px;overflow:auto;white-space:pre-wrap;word-break:break-word}\
.log div.act{color:#6dffa8}.log div.warn{color:#ffd166}.log div.error{color:#ff7a8a}.log div.dry{color:#8fd1ff}\
.pl{display:flex;justify-content:space-between;gap:6px;border-bottom:1px dashed #222b3a;padding:1px 0}';

function mountUI() {
  if (UI.host && document.documentElement.contains(UI.host)) return;
  const old = document.getElementById(HOST_ID); if (old) old.remove();
  UI.host = h('div', { id: HOST_ID });
  UI.root = UI.host.attachShadow({ mode: 'open' });
  const E = UI.els = {};
  const num = function (key, min, max, step, w) {
    const i = h('input', { type: 'number', min: min, max: max, step: step });
    i.value = settings[key];
    i.addEventListener('change', function () { const v = parseFloat(i.value); if (isFinite(v)) { settings[key] = Math.min(max, Math.max(min, v)); i.value = settings[key]; saveSettings(); log('setting ' + key + ' = ' + settings[key]); } });
    return i;
  };
  const range = function (key) {
    const i = h('input', { type: 'range', min: 0, max: 1, step: 0.05 }); i.value = settings[key];
    const t = h('span', { class: 'dim', text: Number(settings[key]).toFixed(2) });
    i.addEventListener('input', function () { settings[key] = parseFloat(i.value); t.textContent = settings[key].toFixed(2); saveSettings(); });
    return h('div', { class: 'row' }, [h('span', { text: key.replace(/([A-Z])/g, ' $1').toLowerCase(), class: 'dim' }), i, t]);
  };
  const toggle = function (key, label, onChange) {
    const c = h('input', { type: 'checkbox' }); c.checked = !!settings[key];
    c.addEventListener('change', function () { settings[key] = c.checked; saveSettings(); log(key + ' = ' + c.checked); if (onChange) onChange(); uiDirty(); });
    return h('label', {}, [c, h('span', { text: label })]);
  };

  E.status = h('div', { class: 'st' });
  E.state = h('div', { class: 'st dim' });
  E.decision = h('div', { class: 'st' });
  E.manual = h('div', { class: 'row' });
  E.me = h('div', { class: 'box' });
  E.opps = h('div', { class: 'box' });
  E.adv = h('div', { class: 'box dim' });
  E.log = h('div', { class: 'box log' });
  E.body = h('div', { class: 'bd' }, [
    E.status, E.state,
    h('div', { class: 'row' }, [
      h('button', { class: 'go', text: 'Start', onclick: function () { startBot(); } }),
      h('button', { class: 'stop', text: 'Stop', onclick: function () { stopBot(); } }),
      h('button', { text: 'Evaluate', title: 'Read state and log the decision once, without clicking', onclick: evaluateOnce })
    ]),
    E.decision, E.manual,
    h('div', { class: 'row' }, [toggle('dryRun', 'Dry-run (no clicks)'), toggle('manualStep', 'Manual-step'), toggle('learningLog', 'Learning log')]),
    h('h4', { text: 'Strategy' }),
    h('div', { class: 'row' }, [h('span', { class: 'dim', text: 'reserve base $' }), num('reserveBase', 0, 5000, 10), h('span', { class: 'dim', text: 'delay ms' }), num('actionDelayMs', 0, 5000, 50)]),
    range('riskTolerance'), range('purchaseAggressiveness'), range('developmentAggressiveness'),
    h('div', { class: 'row' }, [h('span', { class: 'dim', text: 'my name' }), (function () {
      const i = h('input', { type: 'text', placeholder: 'as shown in game' }); i.value = settings.myName;
      i.addEventListener('change', function () { settings.myName = i.value; saveSettings(); log('my name set'); }); return i; })()]),
    h('h4', { text: 'Me' }), E.me, h('h4', { text: 'Opponents' }), E.opps,
    h('h4', { text: 'Advisory (not executed)' }), E.adv,
    h('h4', { text: 'Action log' }), E.log,
    h('div', { class: 'row' }, [
      h('button', { text: 'Probe', title: 'Report which state sources were found', onclick: function () { const p = probe(); log('probe: origin=' + p.report.framework.origin + ' players=' + (p.report.framework.diag && p.report.framework.diag.playersFound || 0) + ' squares=' + (p.report.framework.diag && p.report.framework.diag.squaresFound || 0) + ' quality=' + p.report.stateQuality.level, 'dry'); } }),
      h('button', { text: 'Dump state', title: 'Download a sanitized snapshot', onclick: function () { const d = JSON.stringify(makeDump(), null, 2); copyText(d); download('richup-bot-dump.json', d); } }),
      h('button', { text: 'Export log', title: 'Download decision/observation log', onclick: function () { download('richup-bot-learning-log.json', JSON.stringify({ version: BOT_VERSION, entries: rt.obs }, null, 2)); } }),
      h('button', { text: 'Clear log', onclick: function () { rt.log.length = 0; rt.obs.length = 0; uiDirty(); } })
    ])
  ]);
  E.panel = h('div', { class: 'p' + (settings.collapsed ? ' col' : '') }, [
    (E.header = h('div', { class: 'hd' }, [h('b', { text: 'Richup Strategic Bot v' + BOT_VERSION }), (E.fold = h('button', { text: settings.collapsed ? '+' : '–' }))])),
    E.body
  ]);
  UI.root.appendChild(h('style', { text: CSS }));
  UI.root.appendChild(E.panel);
  document.documentElement.appendChild(UI.host);

  E.fold.addEventListener('click', function () { settings.collapsed = !settings.collapsed; E.panel.classList.toggle('col', settings.collapsed); E.fold.textContent = settings.collapsed ? '+' : '–'; saveSettings(); });
  if (settings.posX != null) { E.panel.style.left = settings.posX + 'px'; E.panel.style.top = settings.posY + 'px'; E.panel.style.right = 'auto'; }
  let drag = null;
  E.header.addEventListener('mousedown', function (ev) { if (ev.target === E.fold) return; const r = E.panel.getBoundingClientRect(); drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top }; ev.preventDefault(); });
  UI.onMove = function (ev) { if (!drag) return; const x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - drag.dx)), y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - drag.dy)); E.panel.style.left = x + 'px'; E.panel.style.top = y + 'px'; E.panel.style.right = 'auto'; settings.posX = x; settings.posY = y; };
  UI.onUp = function () { if (drag) { drag = null; saveSettings(); } };
  document.addEventListener('mousemove', UI.onMove); document.addEventListener('mouseup', UI.onUp);
  uiDirty();
}

function uiDirty() {
  if (rt.destroyed || !UI.els.panel) return;
  if (rt.uiDirty) return;
  rt.uiDirty = true;
  rt.uiTimer = later(function () { rt.uiDirty = false; renderUI(); }, 200);
}

/** Render the dynamic parts. Exposed for tests so hostile strings can be pushed through it. */
function renderUI() {
  const E = UI.els; if (!E.panel) return;
  const snap = rt.lastSnap;
  const mode = settings.dryRun ? 'DRY-RUN' : settings.manualStep ? 'MANUAL-STEP' : 'LIVE';
  E.status.textContent = (rt.running ? 'RUNNING' : 'STOPPED' + (rt.stopReason ? ' (' + rt.stopReason + ')' : '')) + '  ·  mode: ' + mode;
  E.status.className = 'st ' + (rt.running ? (settings.dryRun ? 'warn' : 'ok') : 'bad');
  if (snap) {
    const v = snap.validation;
    E.state.textContent = 'state: ' + v.level + ' · source: ' + snap.origin + (snap.meNote ? ' · me ' + snap.meNote : '') +
      (v.fatal.concat(v.warnings).length ? ' · ' + v.fatal.concat(v.warnings).join(', ') : '');
    E.state.className = 'st ' + (v.level === 'full' ? 'ok' : v.level === 'degraded' ? 'warn' : 'bad');
  } else { E.state.textContent = 'state: not read yet (press Evaluate or Start)'; E.state.className = 'st dim'; }
  E.decision.textContent = 'phase: ' + rt.phase;

  clear(E.manual);
  if (settings.manualStep && rt.pendingManual) {
    E.manual.appendChild(h('button', { class: 'go', text: 'Execute: ' + rt.pendingManual.decision.label, onclick: executePending }));
    E.manual.appendChild(h('span', { class: 'dim', text: rt.pendingManual.decision.reason }));
  }
  renderPlayers(E.me, E.opps, snap ? snap.state : null);

  clear(E.adv);
  const adv = rt.lastDecision && rt.lastDecision.advisory ? rt.lastDecision.advisory : [];
  if (!adv.length) E.adv.appendChild(h('div', { text: 'none' }));
  adv.forEach(function (a) {
    const t = a.type === 'build' ? 'build: ' + a.reason : a.type === 'liquidate' ? 'raise cash: ' + a.plan.reason + (a.plan.steps || []).map(function (s) { return ' [' + s.type + ' ' + (s.name || s.squareId) + ']'; }).join('')
      : a.type === 'propose-trade' ? 'trade idea: ' + a.proposal.note : a.type;
    E.adv.appendChild(h('div', { text: t }));
  });

  clear(E.log);
  rt.log.slice(-60).forEach(function (l) {
    E.log.appendChild(h('div', { class: l.level, text: new Date(l.t).toLocaleTimeString([], { hour12: false }) + ' ' + l.msg }));
  });
  E.log.scrollTop = E.log.scrollHeight;
}

function renderPlayers(meBox, oppBox, state) {
  clear(meBox); clear(oppBox);
  if (!state || !state.players || !state.players.length) {
    meBox.appendChild(h('div', { class: 'dim', text: 'no player data' })); oppBox.appendChild(h('div', { class: 'dim', text: 'no player data' })); return;
  }
  const money = function (v) { return v == null ? '?' : '$' + v; };
  const props = function (p) { return state.squares.filter(function (q) { return q.owner === p.id; }); };
  state.players.forEach(function (p) {
    const mine = p.id === state.meId;
    const owned = props(p);
    const label = (p.name || p.id) + (p.bankrupt ? ' [out]' : '') + (p.inJail ? ' [jail]' : '') + (p.isBot ? ' [bot]' : '');
    const row = h('div', { class: 'pl' }, [h('span', { text: label }), h('span', { text: money(p.cash) + ' · pos ' + (p.position == null ? '?' : p.position) + ' · ' + (state.squares.some(function (q) { return q.owner !== undefined; }) ? owned.length + ' props' : '? props') })]);
    (mine ? meBox : oppBox).appendChild(row);
    if (mine && owned.length) meBox.appendChild(h('div', { class: 'dim', text: owned.map(function (q) { return (q.name || q.id) + (q.houses ? ' (' + (q.houses === 5 ? 'H' : q.houses) + ')' : '') + (q.mortgaged ? ' [M]' : ''); }).join(', ') }));
  });
  if (!state.meId) meBox.appendChild(h('div', { class: 'bad', text: 'own player not identified: set "my name"' }));
  if (!oppBox.firstChild) oppBox.appendChild(h('div', { class: 'dim', text: 'none' }));
}

// ---------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------
function cleanup() {
  rt.destroyed = true;
  stopBot();
  if (rt.hostObserver) { rt.hostObserver.disconnect(); rt.hostObserver = null; }
  if (rt.keyHandler) { document.removeEventListener('keydown', rt.keyHandler); rt.keyHandler = null; }
  if (UI.onMove) document.removeEventListener('mousemove', UI.onMove);
  if (UI.onUp) document.removeEventListener('mouseup', UI.onUp);
  if (UI.host) UI.host.remove();
  const old = document.getElementById(HOST_ID); if (old) old.remove();
  clearTimers();
}

function init() {
  mountUI();
  // Re-attach the panel if the game's rerender removes it. Observes only direct children of <html>.
  rt.hostObserver = new MutationObserver(function () { if (!rt.destroyed && UI.host && !document.documentElement.contains(UI.host)) { UI.host = null; mountUI(); } });
  rt.hostObserver.observe(document.documentElement, { childList: true });
  // Emergency stop that works even if the panel is hidden: Alt+Shift+X
  rt.keyHandler = function (e) { if (e.altKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) { e.preventDefault(); stopBot('emergency stop hotkey'); } };
  document.addEventListener('keydown', rt.keyHandler);
  log('loaded v' + BOT_VERSION + ' in DRY-RUN mode. Press Probe/Evaluate first; nothing is clicked until you turn Dry-run off.');
}

window.__richupStrategicBot = {
  version: BOT_VERSION, cleanup: cleanup, start: startBot, stop: stopBot, evaluate: evaluateOnce, probe: probe, dump: makeDump,
  // test hooks
  _test: { rt: rt, settings: settings, renderPlayers: renderPlayers, renderUI: renderUI, buildSnapshot: buildSnapshot, runCycle: runCycle, Engine: Engine, UI: UI, readButtons: readButtons, download: download }
};
init();
})();
