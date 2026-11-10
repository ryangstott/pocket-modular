// Pocket Modular DSP engine. Runs on the audio thread as an AudioWorklet.
// Block-based (128 frames), one shared signal format (float, ±1 ≈ ±5V, 0.1 = ... pitch is 1.0 = 1 octave),
// polyphonic modules run per active voice; idle voices sleep. Allocation-free in process().
const SR = sampleRate, BS = 128, NV = 8;
const ZERO = new Float32Array(BS);
const POLY = { keys: 1, vco: 1, noise: 1, mixer: 1, vcf: 1, vca: 1, adsr: 1 };
const OUTS = { keys: ['pitch', 'gate', 'vel'], vco: ['out'], noise: ['out'], mixer: ['out'], vcf: ['out'], vca: ['out'], adsr: ['out'], lfo: ['out'], delay: ['out'], reverb: ['out'], scope: [], output: [], clock: ['clk'], seq: ['pitch', 'gate', 'acc', 'mod'] };
const INS = { keys: [], vco: ['pitch', 'mod'], noise: [], mixer: ['in1', 'in2', 'in3', 'in4'], vcf: ['in', 'env', 'mod'], vca: ['in', 'cv'], adsr: ['gate'], lfo: [], delay: ['in'], reverb: ['in'], scope: ['in'], output: ['in'], clock: [], seq: ['clk'] };
const WAVE = { sine: 0, triangle: 1, sawtooth: 2, square: 3 };
const SCALES = { penta: [0, 3, 5, 7, 10], minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], chrom: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
function quant(n, sc) { const o = Math.floor(n / 12), r = n - o * 12; let best = 0, bd = 99; for (let i = 0; i <= sc.length; i++) { const d = i < sc.length ? sc[i] : 12, dist = Math.abs(r - d); if (dist < bd) { bd = dist; best = d; } } return o * 12 + best; }

function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
function lfoWave(w, ph) {
  switch (w) {
    case 0: return Math.sin(ph * 6.283185307179586);
    case 1: return ph < 0.25 ? ph * 4 : ph < 0.75 ? 2 - ph * 4 : ph * 4 - 4;
    case 2: return ph < 0.5 ? ph * 2 : ph * 2 - 2;
    default: return ph < 0.5 ? 1 : -1;
  }
}
function initState(type, v) {
  switch (type) {
    case 'keys': return { pitch: 0 };
    case 'vco': return { ph: Math.random() };
    case 'noise': return { s: ((v + 1) * 2654435761) >>> 0 || 1, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0 };
    case 'vcf': return { a: 0, b: 0 };
    case 'adsr': return { stage: 0, lvl: 0, pg: 0 };
    case 'lfo': return { ph: 0 };
    case 'delay': return { buf: new Float32Array(Math.ceil(SR * 1.6) + 4), w: 0, t: -1, lp: 0 };
    case 'reverb': {
      const sc = SR / 44100;
      const cl = [1116, 1188, 1277, 1356], al = [556, 441];
      return {
        c0: new Float32Array(Math.round(cl[0] * sc)), c1: new Float32Array(Math.round(cl[1] * sc)),
        c2: new Float32Array(Math.round(cl[2] * sc)), c3: new Float32Array(Math.round(cl[3] * sc)),
        a0: new Float32Array(Math.round(al[0] * sc)), a1: new Float32Array(Math.round(al[1] * sc)),
        i0: 0, i1: 0, i2: 0, i3: 0, j0: 0, j1: 0, f0: 0, f1: 0, f2: 0, f3: 0, g: new Float32Array(4), gs: -1
      };
    }
    case 'scope': return { ring: new Float32Array(2048), w: 0 };
    case 'output': return { x1: 0, y1: 0, env: 0, g: 1, peak: 0, red: 0 };
    case 'clock': return { ph: 0, pg: 0, n: 0, was: 0 };
    case 'seq': return { step: -1, pc: 0, since: 1e9, interval: SR * 0.125, gate: 0, gOff: 0, pitch: 0, tgt: 0, slide: false, acc: 0, mod: 0, retrig: 0 };
    default: return {};
  }
}
function makeMod(id, type, params) {
  const poly = !!POLY[type], nv = poly ? NV : 1;
  const m = { id, type, poly, p: Object.assign({}, params), outs: {}, src: {}, sum: {}, st: [] };
  for (const o of OUTS[type]) { m.outs[o] = []; for (let v = 0; v < nv; v++) m.outs[o].push(new Float32Array(BS)); }
  for (const i of INS[type]) m.sum[i] = new Float32Array(BS);
  for (let v = 0; v < nv; v++) m.st.push(initState(type, v));
  return m;
}

class PocketEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mods = new Map(); this.order = []; this.seqs = []; this.clocks = []; this.keysUsed = true; this.keys = null; this.adsrs = []; this.scopes = []; this.outputs = [];
    this.voices = [];
    for (let i = 0; i < NV; i++) this.voices.push({ note: -1, on: false, act: false, off: -1e12, seq: 0, target: 0, vel: 0.8, retrig: false, jump: true });
    this.actArr = new Int32Array(NV); this.actN = 0;
    this.held = []; this.seq = 0; this.frame = 0; this.rep = 0; this.L = null;
    this.port.onmessage = (e) => this.msg(e.data);
  }
  N() { return this.keys ? Math.max(1, Math.min(NV, this.keys.p.voices | 0)) : NV; }
  msg(d) {
    switch (d.t) {
      case 'patch': this.setPatch(d); break;
      case 'param': { const m = this.mods.get(d.id); if (m) { m.p[d.k] = d.v; if (m.type === 'keys' && d.k === 'voices') this.trim(); } break; }
      case 'on': this.noteOn(d.n, d.vel); break;
      case 'off': this.noteOff(d.n); break;
      case 'panic': for (const v of this.voices) { if (v.on) { v.on = false; v.off = this.frame; } } this.held = []; break;
    }
  }
  setPatch(d) {
    const next = new Map();
    for (const md of d.modules) {
      if (!OUTS[md.type]) continue;
      let m = this.mods.get(md.id);
      if (!m || m.type !== md.type) m = makeMod(md.id, md.type, md.params); else Object.assign(m.p, md.params);
      m.src = {}; m.fn = this['r_' + md.type]; next.set(md.id, m);
    }
    for (const c of d.cables) {
      const s = next.get(c.from[0]), t = next.get(c.to[0]);
      if (!s || !t || !s.outs[c.from[1]] || !t.sum[c.to[1]]) continue;
      t.src[c.to[1]] = { m: s, o: c.from[1] };
    }
    const ids = [...next.keys()], indeg = new Map(ids.map(i => [i, 0])), adj = new Map(ids.map(i => [i, []]));
    for (const m of next.values()) for (const k in m.src) { adj.get(m.src[k].m.id).push(m.id); indeg.set(m.id, indeg.get(m.id) + 1); }
    const q = ids.filter(i => indeg.get(i) === 0), order = [];
    while (q.length) { const i = q.shift(); order.push(i); for (const j of adj.get(i)) { indeg.set(j, indeg.get(j) - 1); if (indeg.get(j) === 0) q.push(j); } }
    for (const i of ids) if (!order.includes(i)) order.push(i); // cycles: read last block's buffer (one-block delay)
    this.mods = next;
    this.order = order.map(i => next.get(i));
    this.keys = this.order.find(m => m.type === 'keys') || null;
    this.adsrs = this.order.filter(m => m.type === 'adsr');
    this.scopes = this.order.filter(m => m.type === 'scope');
    this.outputs = this.order.filter(m => m.type === 'output');
    this.seqs = this.order.filter(m => m.type === 'seq');
    this.clocks = this.order.filter(m => m.type === 'clock');
    // When nothing is patched from Keys (e.g. a sequencer is playing), extra voices stay asleep so key presses don't double the sound.
    this.keysUsed = !!this.keys && d.cables.some(c => c.from[0] === this.keys.id);
    this.trim();
  }
  trim() { const N = this.N(); for (let i = N; i < NV; i++) { const v = this.voices[i]; if (v.on) { v.on = false; v.off = this.frame; } } if (N === 1 && !this.voices[0].on) this.held = []; }
  start(vi, n, vel, trig) {
    const v = this.voices[vi];
    v.target = (n - 60) / 12; v.note = n; v.seq = ++this.seq;
    if (trig) { if (v.on) v.retrig = true; v.on = true; v.vel = vel; }
  }
  noteOn(n, vel) {
    const N = this.N(), vs = this.voices;
    if (N === 1) { this.held = this.held.filter(x => x !== n); this.held.push(n); this.start(0, n, vel, !vs[0].on); return; }
    let vi = -1;
    for (let i = 0; i < N; i++) if (vs[i].on && vs[i].note === n) { vi = i; break; }
    if (vi < 0) {
      let best = -1, bs = Infinity;
      for (let pass = 0; pass < 3 && best < 0; pass++) {
        for (let i = 0; i < N; i++) {
          const v = vs[i];
          const ok = pass === 0 ? (!v.on && !v.act) : pass === 1 ? !v.on : true;
          if (ok && v.seq < bs) { bs = v.seq; best = i; }
        }
      }
      vi = best;
    }
    this.start(vi, n, vel, true);
  }
  noteOff(n) {
    const vs = this.voices;
    if (this.N() === 1) {
      this.held = this.held.filter(x => x !== n);
      const v = vs[0];
      if (v.on && v.note === n) {
        if (this.held.length) this.start(0, this.held[this.held.length - 1], v.vel, false);
        else { v.on = false; v.off = this.frame; }
      }
      return;
    }
    for (const v of vs) if (v.on && v.note === n) { v.on = false; v.off = this.frame; }
  }
  inp(m, name, v) {
    const s = m.src[name];
    if (!s) return ZERO;
    const sm = s.m;
    if (m.poly) return sm.poly ? sm.outs[s.o][v] : sm.outs[s.o][0];
    if (!sm.poly) return sm.outs[s.o][0];
    const sum = m.sum[name]; sum.fill(0);
    const bufs = sm.outs[s.o];
    for (let k = 0; k < this.actN; k++) { const b = bufs[this.actArr[k]]; for (let i = 0; i < BS; i++) sum[i] += b[i]; }
    return sum;
  }
  run(m, v) { m.fn.call(this, m, v, m.p, m.st[v]); }
  r_keys(m, v, p, st) {
        const vo = this.voices[v], P = m.outs.pitch[v], G = m.outs.gate[v], VL = m.outs.vel[v];
        const tgt = vo.target, gl = p.glide;
        const c = gl > 0.001 ? 1 - Math.exp(-1 / (gl / 3 * SR)) : 1;
        let pi = vo.jump ? tgt : st.pitch;
        const g = vo.on ? 1 : 0;
        for (let i = 0; i < BS; i++) { pi += (tgt - pi) * c; P[i] = pi; G[i] = g; }
        if (vo.retrig && g) { G[0] = 0; G[1] = 0; }
        st.pitch = pi; VL.fill(vo.vel);
  }
  r_vco(m, v, p, st) {
        const O = m.outs.out[v], pin = this.inp(m, 'pitch', v), min = this.inp(m, 'mod', v);
        const base = p.oct + p.fine / 1200, md = p.mod, lv = p.level, w = WAVE[p.wave] ?? 2, nyq = SR * 0.45;
        const fixed = pin === ZERO && (min === ZERO || md === 0);
        let ph = st.ph, dt = Math.min(nyq, 261.6256 * Math.pow(2, base + pin[0] + min[0] * md)) / SR;
        // Pitch is evaluated at control rate (every 8 samples): exp2 per sample was the main CPU cost.
        for (let s0 = 0; s0 < BS; s0 += 8) {
          if (!fixed && s0) { let f = 261.6256 * Math.pow(2, base + pin[s0] + min[s0] * md); if (f > nyq) f = nyq; else if (f < 0.01) f = 0.01; dt = f / SR; }
          const e = s0 + 8, idt = 1 / dt;
          if (w === 2) {
            for (let i = s0; i < e; i++) {
              let y = 2 * ph - 1, t;
              if (ph < dt) { t = ph * idt; y -= t + t - t * t - 1; } else if (ph > 1 - dt) { t = (ph - 1) * idt; y -= t * t + t + t + 1; }
              O[i] = y * lv; ph += dt; if (ph >= 1) ph -= 1;
            }
          } else if (w === 3) {
            for (let i = s0; i < e; i++) {
              let y = ph < 0.5 ? 1 : -1, t, p2 = ph + 0.5; if (p2 >= 1) p2 -= 1;
              if (ph < dt) { t = ph * idt; y += t + t - t * t - 1; } else if (ph > 1 - dt) { t = (ph - 1) * idt; y += t * t + t + t + 1; }
              if (p2 < dt) { t = p2 * idt; y -= t + t - t * t - 1; } else if (p2 > 1 - dt) { t = (p2 - 1) * idt; y -= t * t + t + t + 1; }
              O[i] = y * lv; ph += dt; if (ph >= 1) ph -= 1;
            }
          } else if (w === 1) {
            for (let i = s0; i < e; i++) { O[i] = (ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph) * lv; ph += dt; if (ph >= 1) ph -= 1; }
          } else {
            for (let i = s0; i < e; i++) { O[i] = Math.sin(ph * 6.283185307179586) * lv; ph += dt; if (ph >= 1) ph -= 1; }
          }
        }
        st.ph = ph;
  }
  r_noise(m, v, p, st) {
        const O = m.outs.out[v], lv = p.level, pink = p.color === 'pink';
        let s = st.s;
        for (let i = 0; i < BS; i++) {
          s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
          const w = s / 2147483648 - 1;
          if (pink) {
            st.b0 = 0.99886 * st.b0 + w * 0.0555179; st.b1 = 0.99332 * st.b1 + w * 0.0750759; st.b2 = 0.969 * st.b2 + w * 0.153852;
            st.b3 = 0.8665 * st.b3 + w * 0.3104856; st.b4 = 0.55 * st.b4 + w * 0.5329522; st.b5 = -0.7616 * st.b5 - w * 0.016898;
            O[i] = (st.b0 + st.b1 + st.b2 + st.b3 + st.b4 + st.b5 + st.b6 + w * 0.5362) * 0.11 * lv; st.b6 = w * 0.115926;
          } else O[i] = w * 0.5 * lv;
        }
        st.s = s;
  }
  r_mixer(m, v, p, st) {
        const O = m.outs.out[v], a = this.inp(m, 'in1', v), b = this.inp(m, 'in2', v), c = this.inp(m, 'in3', v), d = this.inp(m, 'in4', v);
        const l1 = p.l1, l2 = p.l2, l3 = p.l3, l4 = p.l4, ms = p.master;
        for (let i = 0; i < BS; i++) O[i] = (a[i] * l1 + b[i] * l2 + c[i] * l3 + d[i] * l4) * ms;
  }
  r_vcf(m, v, p, st) {
        // Cytomic state-variable filter, 12 dB/oct, cutoff modulated in octaves.
        const O = m.outs.out[v], x = this.inp(m, 'in', v), e = this.inp(m, 'env', v), mo = this.inp(m, 'mod', v);
        const k = 2 - 2 * Math.min(1, p.res) * 0.985, mode = p.type === 'highpass' ? 1 : p.type === 'bandpass' ? 2 : 0;
        const ea = p.env, ma = p.mod, fc0 = p.cutoff, nyq = SR * 0.45;
        const fixed = (e === ZERO || ea === 0) && (mo === ZERO || ma === 0);
        let a = st.a, b = st.b, a1 = 0, a2 = 0, a3 = 0;
        for (let i = 0; i < BS; i++) {
          if (fixed ? i === 0 : (i & 7) === 0) {
            let fc = fixed ? fc0 : fc0 * Math.pow(2, e[i] * ea + mo[i] * ma);
            if (fc < 10) fc = 10; else if (fc > nyq) fc = nyq;
            const g = Math.tan(Math.PI * fc / SR);
            a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
          }
          const xi = x[i], v3 = xi - b, v1 = a1 * a + a2 * v3, v2 = b + a2 * a + a3 * v3;
          a = 2 * v1 - a; b = 2 * v2 - b;
          O[i] = mode === 0 ? v2 : mode === 1 ? xi - k * v1 - v2 : v1 * k;
        }
        if (!(Math.abs(a) < 1e6) || !(Math.abs(b) < 1e6)) { a = 0; b = 0; }
        st.a = a; st.b = b;
  }
  r_vca(m, v, p, st) {
        const O = m.outs.out[v], x = this.inp(m, 'in', v), cv = this.inp(m, 'cv', v), lv = p.level;
        for (let i = 0; i < BS; i++) O[i] = x[i] * cv[i] * lv;
  }
  r_adsr(m, v, p, st) {
        const O = m.outs.out[v], G = this.inp(m, 'gate', v);
        const ar = 1 / (Math.max(p.a, 0.001) * SR);
        const dc = 1 - Math.exp(-4 / (Math.max(p.d, 0.002) * SR));
        const rc = 1 - Math.exp(-4 / (Math.max(p.r, 0.002) * SR));
        const s = p.s;
        let lvl = st.lvl, stg = st.stage, pg = st.pg;
        for (let i = 0; i < BS; i++) {
          const g = G[i] > 0.5 ? 1 : 0;
          if (g && !pg) stg = 1; else if (!g && pg && stg !== 0) stg = 4;
          pg = g;
          if (stg === 1) { lvl += ar; if (lvl >= 1) { lvl = 1; stg = 2; } }
          else if (stg === 2) lvl += (s - lvl) * dc;
          else if (stg === 4) { lvl -= lvl * rc; if (lvl < 1e-5) { lvl = 0; stg = 0; } }
          O[i] = lvl;
        }
        st.lvl = lvl; st.stage = stg; st.pg = pg;
  }
  r_lfo(m, v, p, st) {
        const O = m.outs.out[0], w = WAVE[p.wave] ?? 1, inc = p.rate / SR, dp = p.depth;
        let ph = st.ph;
        for (let i = 0; i < BS; i++) { O[i] = lfoWave(w, ph) * dp; ph += inc; if (ph >= 1) ph -= 1; }
        st.ph = ph;
  }
  r_delay(m, v, p, st) {
        const O = m.outs.out[0], x = this.inp(m, 'in', 0), buf = st.buf, L = buf.length;
        if (st.t < 0) st.t = p.time;
        const sm = 1 - Math.exp(-1 / (0.06 * SR)), lpc = 1 - Math.exp(-6.283185307179586 * 3800 / SR);
        const fb = p.fb, mix = p.mix, tt = p.time;
        let t = st.t, w = st.w, lp = st.lp;
        for (let i = 0; i < BS; i++) {
          t += (tt - t) * sm;
          let rp = w - t * SR; if (rp < 0) rp += L;
          const i0 = rp | 0, fr = rp - i0, i1 = i0 + 1 >= L ? 0 : i0 + 1;
          const d = buf[i0] + (buf[i1] - buf[i0]) * fr;
          lp += (d - lp) * lpc;
          buf[w] = x[i] + lp * fb;
          w = w + 1 >= L ? 0 : w + 1;
          O[i] = x[i] + lp * mix;
        }
        if (!(Math.abs(lp) < 1e6)) { lp = 0; buf.fill(0); }
        st.t = t; st.w = w; st.lp = lp;
  }
  r_reverb(m, v, p, st) {
        // Small Schroeder/Freeverb-style network: 4 damped combs + 2 allpasses.
        const O = m.outs.out[0], x = this.inp(m, 'in', 0);
        if (st.gs !== p.size) {
          const ls = [st.c0.length, st.c1.length, st.c2.length, st.c3.length];
          for (let j = 0; j < 4; j++) st.g[j] = Math.pow(10, -3 * ls[j] / (Math.max(0.3, p.size) * SR));
          st.gs = p.size;
        }
        const g0 = st.g[0], g1 = st.g[1], g2 = st.g[2], g3 = st.g[3], dm = 0.28, dm1 = 1 - dm;
        const dry = Math.cos(p.mix * Math.PI / 2), wet = Math.sin(p.mix * Math.PI / 2) * 0.9;
        const c0 = st.c0, c1 = st.c1, c2 = st.c2, c3 = st.c3, A0 = st.a0, A1 = st.a1;
        let i0 = st.i0, i1 = st.i1, i2 = st.i2, i3 = st.i3, j0 = st.j0, j1 = st.j1, f0 = st.f0, f1 = st.f1, f2 = st.f2, f3 = st.f3;
        for (let i = 0; i < BS; i++) {
          const inp = x[i] * 0.2;
          let y, acc = 0;
          y = c0[i0]; f0 = y * dm1 + f0 * dm; c0[i0] = inp + f0 * g0; if (++i0 >= c0.length) i0 = 0; acc += y;
          y = c1[i1]; f1 = y * dm1 + f1 * dm; c1[i1] = inp + f1 * g1; if (++i1 >= c1.length) i1 = 0; acc += y;
          y = c2[i2]; f2 = y * dm1 + f2 * dm; c2[i2] = inp + f2 * g2; if (++i2 >= c2.length) i2 = 0; acc += y;
          y = c3[i3]; f3 = y * dm1 + f3 * dm; c3[i3] = inp + f3 * g3; if (++i3 >= c3.length) i3 = 0; acc += y;
          let bv = A0[j0]; y = bv - acc; A0[j0] = acc + bv * 0.5; if (++j0 >= A0.length) j0 = 0; acc = y;
          bv = A1[j1]; y = bv - acc; A1[j1] = acc + bv * 0.5; if (++j1 >= A1.length) j1 = 0; acc = y;
          O[i] = x[i] * dry + acc * wet;
        }
        if (!(Math.abs(f0) < 1e6)) { f0 = f1 = f2 = f3 = 0; c0.fill(0); c1.fill(0); c2.fill(0); c3.fill(0); A0.fill(0); A1.fill(0); }
        st.i0 = i0; st.i1 = i1; st.i2 = i2; st.i3 = i3; st.j0 = j0; st.j1 = j1; st.f0 = f0; st.f1 = f1; st.f2 = f2; st.f3 = f3;
  }
  r_scope(m, v, p, st) {
        const x = this.inp(m, 'in', 0), r = st.ring;
        let w = st.w;
        for (let i = 0; i < BS; i++) { r[w] = x[i]; w = (w + 1) & 2047; }
        st.w = w;
  }
  r_output(m, v, p, st) {
        // DC blocker, volume, peak limiter at -1 dBFS, hard safety clip.
        const x = this.inp(m, 'in', 0), L = this.L, vol = p.vol * p.vol, thr = 0.89;
        const rel = Math.exp(-1 / (0.12 * SR)), grel = 1 - Math.exp(-1 / (0.08 * SR));
        let x1 = st.x1, y1 = st.y1, env = st.env, g = st.g, peak = st.peak, minG = 1;
        for (let i = 0; i < BS; i++) {
          const xi = x[i];
          let y = xi - x1 + 0.995 * y1; x1 = xi; y1 = y;
          let s = y * vol;
          const a = s < 0 ? -s : s;
          env = a > env ? a : env * rel;
          const tg = env > thr ? thr / env : 1;
          g = tg < g ? tg : g + (tg - g) * grel;
          s *= g;
          if (s > 1) s = 1; else if (s < -1) s = -1;
          L[i] += s;
          const as = s < 0 ? -s : s;
          if (as > peak) peak = as;
          if (g < minG) minG = g;
        }
        if (!(Math.abs(y1) < 1e6)) { x1 = 0; y1 = 0; env = 0; g = 1; }
        st.x1 = x1; st.y1 = y1; st.env = env; st.g = g; st.peak = peak;
        const red = -20 * Math.log10(minG); if (red > st.red) st.red = red;
  }
  r_clock(m, v, p, st) {
        // 16th-note pulses. Phase runs over a pair of steps so swing can push every second pulse late.
        const O = m.outs.clk[0];
        if (p.run === 'stop') { O.fill(0); st.ph = 0; st.pg = 0; st.was = 0; return; }
        const inc = p.bpm / 15 / SR, sw = Math.min(0.5, Math.max(0, p.swing));
        let ph = st.ph, pg = st.pg, n = st.n;
        for (let i = 0; i < BS; i++) {
          const odd = ph >= 1 + sw, start = odd ? 1 + sw : 0, len = odd ? 1 - sw : 1 + sw;
          const g = ph - start < len * 0.5 ? 1 : 0;
          if (g && !pg) n++;
          O[i] = g; pg = g;
          ph += inc; if (ph >= 2) ph -= 2;
        }
        st.ph = ph; st.pg = pg; st.n = n; st.was = 1;
  }
  r_seq(m, v, p, st) {
        const C = this.inp(m, 'clk', 0), P = m.outs.pitch[0], G = m.outs.gate[0], A = m.outs.acc[0], M = m.outs.mod[0];
        const len = Math.max(1, Math.min(16, p.length | 0)), sc = SCALES[p.scale] || SCALES.penta, base = p.root / 12 + p.oct;
        const gates = p.gates, notes = p.notes, ties = p.ties, accs = p.accs, mods = p.mods;
        const slideC = 1 - Math.exp(-1 / (0.045 * SR)), glen = p.glen;
        for (let i = 0; i < BS; i++) {
          const c = C[i] > 0.5;
          if (c && !st.pc) {
            if (st.since > SR * 1.2) st.step = -1; else st.interval = st.since;
            st.since = 0;
            const prev = st.step, s = st.step = (st.step + 1) % len;
            const on = gates[s] > 0, prevTie = prev >= 0 && ties[prev] > 0 && gates[prev] > 0 && st.gate;
            if (on) {
              st.tgt = base + quant(notes[s] | 0, sc) / 12;
              st.slide = !!prevTie;
              if (!st.slide) { if (st.gate) st.retrig = 3; st.pitch = st.tgt; }
              st.gate = 1;
              st.gOff = ties[s] > 0 ? Infinity : Math.max(4, glen * st.interval);
              st.acc = accs[s] > 0 ? 1 : 0;
            } else { st.gate = 0; st.acc = 0; }
            st.mod = mods[s] || 0;
          }
          st.pc = c; st.since++;
          if (st.gate && st.since >= st.gOff) st.gate = 0;
          if (st.slide) st.pitch += (st.tgt - st.pitch) * slideC;
          let g = st.gate;
          if (st.retrig > 0) { st.retrig--; g = 0; }
          P[i] = st.pitch; G[i] = g; A[i] = st.acc; M[i] = st.mod;
        }
        if (st.since > SR * 1.2 && st.gate) st.gate = 0;
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1];
    if (!L) return true;
    L.fill(0); this.L = L;
    const vs = this.voices, ad = this.adsrs;
    this.actN = 0;
    for (let v = 0; v < NV; v++) {
      const vo = vs[v];
      let a = v === 0 || (vo.on && this.keysUsed);
      if (!a) {
        if (ad.length) { for (let k = 0; k < ad.length; k++) { const s = ad[k].st[v]; if (s.stage !== 0 || s.lvl > 1e-4) { a = true; break; } } }
        else a = (this.frame - vo.off) < SR * 0.05;
      }
      vo.act = a;
      if (a) this.actArr[this.actN++] = v;
    }
    const ord = this.order;
    for (let j = 0; j < ord.length; j++) {
      const m = ord[j];
      if (m.poly) { for (let k = 0; k < this.actN; k++) this.run(m, this.actArr[k]); }
      else this.run(m, 0);
    }
    for (let v = 0; v < NV; v++) { vs[v].retrig = false; if (vs[v].on) vs[v].jump = false; }
    if (R) R.set(L);
    this.frame += BS;
    if (this.frame - this.rep >= SR / 30) { this.rep = this.frame; this.report(); }
    return true;
  }
  report() {
    const voices = this.voices.map(v => ({ on: v.on, note: v.note, act: v.act && !v.on }));
    const envs = {}, scopes = {};
    for (const m of this.adsrs) envs[m.id] = m.st.map(s => s.lvl);
    for (const m of this.scopes) {
      const st = m.st[0], r = st.ring, o = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) o[i] = r[(st.w + i) & 2047];
      scopes[m.id] = o;
    }
    let peak = 0, red = 0;
    for (const m of this.outputs) { const st = m.st[0]; peak = Math.max(peak, st.peak); red = Math.max(red, st.red); st.peak = 0; st.red = 0; }
    const seqs = {}, clocks = {};
    for (const m of this.seqs) seqs[m.id] = m.st[0].since > SR * 1.2 ? -1 : m.st[0].step;
    for (const m of this.clocks) clocks[m.id] = m.p.run === 'stop' ? -1 : m.st[0].n;
    this.port.postMessage({ voices, envs, scopes, peak, red, N: this.N(), seqs, clocks });
  }
}
registerProcessor('pm-engine', PocketEngine);
