/**
 * <char-player> — drop a talking character into any web page or HTML slide.
 *
 *   <script type="module" src="runtime/char-player.js"></script>
 *   <char-player src="characters/bhasha.char" audio="hello.mp3" track="hello.lipsync.json"
 *                pose="explain" expression="happy" fit="bust" width="540" height="720" autoplay></char-player>
 *
 * Attributes: src (required) · audio · track (lipsync.json from `char lipsync`) · pose · expression · gaze
 *   · fit body|bust|face · width/height (canvas px; CSS size it however you like) · flip · autoplay · loop
 *   · cues (JSON: [{"at":1.2,"pose":"point","dur":1.5},{"at":2,"expr":"surprised"}]) · background (CSS colour, default transparent)
 * Click toggles play/pause. JS: el.play(), el.pause(), el.seek(t), el.puppet.info()
 */
import { loadChar } from './char.js';
import { Performance } from './player.js';

class CharPlayer extends HTMLElement {
  static observedAttributes = ['src', 'audio', 'track', 'pose', 'expression', 'gaze', 'fit', 'cues', 'flip'];
  connectedCallback() {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:pointer';
      this.style.display ||= 'inline-block';
      this.appendChild(this.canvas);
      this.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    }
    this.#load();
  }
  attributeChangedCallback() { if (this.canvas) this.#load(); }
  disconnectedCallback() { cancelAnimationFrame(this.raf); this.audioEl?.pause(); }

  async #load() {
    const id = (this.loadId = (this.loadId || 0) + 1);
    const a = (k) => this.getAttribute(k);
    this.canvas.width = +(a('width') || 720); this.canvas.height = +(a('height') || 960);
    const [puppet, track] = await Promise.all([
      loadChar(a('src')),
      a('track') ? fetch(new URL(a('track'), location.href)).then((r) => r.json()) : null,
    ]);
    if (id !== this.loadId) return;
    this.puppet = puppet;
    this.perf = new Performance(puppet, { track, pose: a('pose'), expression: a('expression') || 'neutral', gaze: a('gaze') || 'camera',
      cues: a('cues') ? JSON.parse(a('cues')) : [], flip: this.hasAttribute('flip') });
    this.audioEl?.pause();
    this.audioEl = a('audio') ? new Audio(new URL(a('audio'), location.href)) : null;
    if (this.audioEl) this.audioEl.onended = () => { if (this.hasAttribute('loop')) this.seek(0), this.play(); else this.pause(); };
    this.t = 0; this.playing = false;
    this.#frame();
    this.dispatchEvent(new CustomEvent('ready', { detail: puppet.info() }));
    if (this.hasAttribute('autoplay')) this.play();
    else this.#idle();
  }
  play() {
    this.playing = true; this.t0 = performance.now() / 1000 - this.t;
    this.audioEl?.play().catch(() => {}); // autoplay may be blocked until the first click
    this.#tick();
  }
  pause() { this.playing = false; this.audioEl?.pause(); this.#idle(); }
  seek(t) { this.t = t; if (this.audioEl) this.audioEl.currentTime = t; this.t0 = performance.now() / 1000 - t; this.#frame(); }
  #tick() {
    cancelAnimationFrame(this.raf);
    if (!this.playing) return;
    this.t = this.audioEl && !this.audioEl.paused ? this.audioEl.currentTime : performance.now() / 1000 - this.t0;
    const dur = this.perf.duration;
    if (!this.audioEl && dur && this.t > dur) { if (this.hasAttribute('loop')) this.seek(0); else return this.pause(); }
    this.#frame();
    this.raf = requestAnimationFrame(() => this.#tick());
  }
  /** paused: keep breathing and blinking (mouth closed) so the character never looks frozen */
  #idle() {
    cancelAnimationFrame(this.raf);
    const loop = () => { if (this.playing || !this.isConnected) return; this.#frame(performance.now() / 1000 + 1000); this.raf = requestAnimationFrame(loop); };
    loop();
  }
  #frame(lifeT) {
    const c = this.canvas, ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const bg = this.getAttribute('background');
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
    const place = this.perf.fit(c.width, c.height, this.getAttribute('fit') || 'body');
    const st = this.perf.stateAt(this.t);
    if (lifeT != null) { const l = this.perf.stateAt(lifeT); Object.assign(st, { mouth: 'X', open: 0, eyes: l.eyes, breathe: l.breathe }); delete st.tweenOf; }
    this.puppet.draw(ctx, st, place);
  }
}
customElements.get('char-player') || customElements.define('char-player', CharPlayer);
