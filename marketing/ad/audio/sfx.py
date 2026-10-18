"""Sound design for the Nimbus ad (v2, 90 s): every sound is synthesised here (no samples, no licences).

python3 sfx.py  ->  sfx.wav (effects), bed.wav (music bed), mix.wav (both), cues.csv (cue sheet for an editor)
Cue times match ad.html's timeline (v2). Change a time there, change it here.
"""
import csv, wave
import numpy as np

SR = 48000
DUR = 90.0
rng = np.random.default_rng(7)


# ---------- building blocks ----------
def t_(sec):
    return np.arange(int(sec * SR)) / SR

def env_exp(n, decay):  # exponential decay, `decay` seconds to -60 dB
    return np.exp(-6.9 * np.arange(n) / (decay * SR))

def fade(x, a=0.002, r=0.01):
    x = x.copy(); na, nr = int(a * SR), int(r * SR)
    if na: x[:na] *= np.linspace(0, 1, na)
    if nr: x[-nr:] *= np.linspace(1, 0, nr)
    return x

def fft_filter(x, gain):  # gain(freqs) -> amplitude per frequency
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X * gain(f), len(x))

def band(lo, hi, soft=0.25):
    def g(f):
        up = 1 / (1 + (lo / np.maximum(f, 1)) ** (2 / soft))
        dn = 1 / (1 + (f / hi) ** (2 / soft))
        return up * dn
    return g

def lowpass(hi): return band(1, hi)
def highpass(lo): return band(lo, SR / 2)

def sweep_filter(x, centres, q=1.2, win=0.02):  # band-pass whose centre follows `centres` (Hz per window)
    n = int(win * SR); hop = n // 2; out = np.zeros(len(x) + n); w = np.hanning(n)
    steps = max(1, (len(x) - n) // hop + 1)
    for i in range(steps):
        seg = x[i * hop:i * hop + n]
        if len(seg) < n: seg = np.pad(seg, (0, n - len(seg)))
        c = centres[min(len(centres) - 1, int(i / steps * len(centres)))]
        out[i * hop:i * hop + n] += fft_filter(seg * w, band(c / (1 + q), c * (1 + q))) * 0.9
    return out[:len(x)]

_ir = None
def reverb(x, wet=0.25, size=1.4):
    global _ir
    if _ir is None or len(_ir) != int(size * SR):
        n = int(size * SR); _ir = rng.standard_normal(n) * env_exp(n, size) ; _ir = fft_filter(_ir, lowpass(6000)); _ir /= np.sqrt(np.sum(_ir ** 2))
    L = len(x) + len(_ir); y = np.fft.irfft(np.fft.rfft(x, L) * np.fft.rfft(_ir, L), L)
    return np.pad(x, (0, len(_ir))) * (1 - wet) + y * wet

def norm(x, peak=0.9): return x / (np.max(np.abs(x)) + 1e-9) * peak


# ---------- the sounds ----------
def click(bright=1.0):
    n = int(0.05 * SR); t = t_(0.05)
    tick = np.sin(2 * np.pi * 2600 * bright * t) * env_exp(n, 0.012)
    noise = fft_filter(rng.standard_normal(n), highpass(2500)) * env_exp(n, 0.006) * 0.6
    thock = np.sin(2 * np.pi * 190 * t) * env_exp(n, 0.03) * 0.5
    return norm(fade(tick + noise + thock), 0.8)

def key():
    n = int(0.04 * SR); t = t_(0.04); f = rng.uniform(1700, 2600)
    x = np.sin(2 * np.pi * f * t) * env_exp(n, 0.008) + fft_filter(rng.standard_normal(n), band(1500, 7000)) * env_exp(n, 0.005) * .8 + np.sin(2 * np.pi * 140 * t) * env_exp(n, .02) * .4
    return norm(fade(x), rng.uniform(.35, .5))

def pop(f0=900, f1=380, d=0.09):
    t = t_(d); f = np.linspace(f0, f1, len(t)); ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) * env_exp(len(t), d * .9) + fft_filter(rng.standard_normal(len(t)), band(800, 4000)) * env_exp(len(t), .01) * .2
    return norm(fade(x, .001, .01), .7)

def whoosh(d=0.7, lo=280, hi=2600, end=700, pan=True, amt=1.0):
    n = int(d * SR); x = rng.standard_normal(n)
    k = np.linspace(0, 1, 60); cen = np.where(k < .55, lo + (hi - lo) * (k / .55) ** 1.5, hi + (end - hi) * ((k - .55) / .45))
    y = sweep_filter(x, cen, q=.9)
    e = np.sin(np.pi * np.linspace(0, 1, n)) ** 1.6
    y = norm(y * e, .75 * amt)
    if not pan: return y
    p = np.linspace(-.6, .6, n)
    return np.stack([y * np.sqrt((1 - p) / 2) * 1.41, y * np.sqrt((1 + p) / 2) * 1.41], 1)

def swish(): return whoosh(.32, 600, 4200, 1500, amt=.7)

def boom():
    d = 2.2; t = t_(d); f = 52 + 30 * np.exp(-t * 9)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(len(t), 1.6)
    hit = fft_filter(rng.standard_normal(len(t)), lowpass(900)) * env_exp(len(t), .25) * .5
    air = fft_filter(rng.standard_normal(len(t)), band(3000, 9000)) * env_exp(len(t), .5) * .08
    return norm(reverb(fade(sub + hit + air, .002, .2), .3, 1.8), .95)

def shimmer(d=1.6):
    t = t_(d); x = np.zeros(len(t))
    for f in [2093, 2637, 3136, 3951, 4699, 5274]:
        st = rng.uniform(0, .35); e = np.clip((t - st) / .05, 0, 1) * np.exp(-np.clip(t - st, 0, None) * 2.6)
        x += np.sin(2 * np.pi * f * t * (1 + .002 * np.sin(2 * np.pi * 5 * t))) * e * rng.uniform(.4, 1)
    return norm(reverb(x, .45, 2.0), .35)

def chime():  # success: two bell notes, a fifth apart
    d = 1.6; t = t_(d); x = np.zeros(len(t))
    for st, f in [(0, 1046.5), (.085, 1568.0)]:
        tt = np.clip(t - st, 0, None); on = (t >= st)
        for h, a in [(1, 1), (2.01, .35), (3.0, .12)]:
            x += np.sin(2 * np.pi * f * h * tt) * np.exp(-tt * 4.2 * h ** .5) * a * on
    return norm(reverb(x, .3, 1.6), .55)

def ding():  # notification bell
    d = 1.8; t = t_(d); f = 1318.5; x = np.zeros(len(t))
    for h, a in [(1, 1), (2.76, .4), (5.40, .15), (8.93, .06)]:
        x += np.sin(2 * np.pi * f * h * t) * np.exp(-t * 2.4 * h ** .6) * a
    return norm(reverb(x, .3, 1.8), .5)

def zip_(d=.26):  # strike-through
    n = int(d * SR); x = rng.standard_normal(n)
    y = sweep_filter(x, np.linspace(900, 5200, 30), q=.5)
    return norm(y * np.sin(np.pi * np.linspace(0, 1, n)) ** .7 * np.linspace(.5, 1, n), .5)

def glitch(d=1.3):
    out = np.zeros(int(d * SR)); i = 0
    while i < len(out):
        L = int(rng.uniform(.018, .05) * SR); f = rng.choice([220, 330, 440, 660, 880, 1320, 1760]) * rng.uniform(.98, 1.02)
        seg = np.sign(np.sin(2 * np.pi * f * np.arange(L) / SR)) * rng.uniform(.15, .5)
        seg = np.round(seg * 6) / 6  # crushed
        out[i:i + L] = seg[:len(out) - i]; i += L + int(rng.uniform(0, .015) * SR)
    out = fft_filter(out, band(150, 6000)) * np.linspace(1, .4, len(out))
    return norm(fade(out, .005, .08), .28)

def tick():
    n = int(.012 * SR); return norm(np.sin(2 * np.pi * 3800 * t_(.012)) * env_exp(n, .004), .25)

def blip():  # a message arrives
    a = np.sin(2 * np.pi * 660 * t_(.07)) * env_exp(int(.07 * SR), .06)
    b = np.sin(2 * np.pi * 990 * t_(.12)) * env_exp(int(.12 * SR), .1)
    return norm(reverb(np.concatenate([a, b]), .2, 1.0), .4)

def riser(d=1.6):
    t = t_(d); n = len(t)
    noise = sweep_filter(rng.standard_normal(n), np.geomspace(300, 6000, 40), q=.6) * (t / d) ** 2
    tone = np.sin(2 * np.pi * np.cumsum(np.geomspace(110, 440, n)) / SR) * (t / d) ** 2 * .3
    return norm(fade(noise + tone, .05, .03), .4)

def soft_air(d=1.0):  # quiet "push-in" air for camera zooms
    n = int(d * SR); y = fft_filter(rng.standard_normal(n), band(200, 1800)) * np.sin(np.pi * np.linspace(0, 1, n)) ** 2
    return norm(y, .18)


# ---------- the cue list (time s, sound, gain, pan, note) ----------
S = {}
def snd(name, fn):
    if name not in S: S[name] = fn()
    return S[name]

cues = []
def cue(t, name, fn, gain=1.0, pan=0.0, note=''):
    cues.append((t, name, fn, gain, pan, note))

# Logo build (0-5)
cue(0.55, 'whoosh-in', lambda: whoosh(.9, 200, 1800, 500), .7, 0, 'Logo tile flies in')
cue(0.95, 'boom', boom, .9, 0, 'Logo hit as the cloud forms')
cue(1.62, 'pop', lambda: pop(1100, 520, .1), .8, 0, 'The node drops into place')
for i in range(6): cue(1.72 + i * .07, f'key', key, .45, -.3 + i * .12, 'Letters of "Nimbus" land')
cue(2.5, 'shimmer', shimmer, .8, 0, 'Tagline appears')
cue(2.9, 'blip', blip, .5, .2, '"Without the per-user AI bill."')
cue(4.15, 'whoosh-through', lambda: whoosh(.9, 300, 3200, 900), .8, 0, 'Zoom through the logo')

# Problem (5-10.6)
for t0 in [5.0, 6.6]: cue(t0, 'swish', swish, .55, 0, 'Headline in')
cue(8.2, 'swish', swish, .55, 0, '$2.6M headline in')
for i in range(26): cue(8.4 + 1.3 * (1 - (1 - i / 26) ** 1.6), 'tick', tick, .8, 0, 'Counter climbs')
cue(9.72, 'pop', lambda: pop(700, 300, .12), .7, 0, 'Counter lands on $2.6M')

# What AI agents usually mean (10.6-14.8)
cue(10.55, 'swish', swish, .55, 0, '"AI agents usually mean…"')
for i in range(4): cue(10.9 + i * .3, 'card-pop', lambda: pop(620, 260, .11), .6, -.45 + i * .3, f'Cost card {i + 1} rises')
for i in range(4): cue(12.9 + i * .22, 'zip', zip_, .75, -.45 + i * .3, f'Card {i + 1} struck through')
cue(13.2, 'riser', riser, .7, 0, 'Build-up to the answer')
cue(14.75, 'whoosh-through', lambda: whoosh(.9, 300, 3200, 900), .7, 0, '"Nimbus connects in two minutes."')

# Connect (16.4-20.6)
cue(16.35, 'window-in', lambda: whoosh(.8, 250, 2000, 600), .65, 0, 'Window flies in: Salesforce orgs')
cue(17.4, 'air', soft_air, .8, 0, 'Camera pushes in')
cue(19.1, 'click', click, .9, .1, 'Click "Install in Salesforce"')
cue(19.3, 'chime', chime, .7, .1, 'Toast: Installed · Ready')
cue(20.1, 'whoosh-out', lambda: whoosh(.6, 900, 2200, 400), .45, 0, 'Window leaves')

# Inside Salesforce (20.6-33.4)
cue(20.55, 'swish', swish, .55, 0, '"It lives inside Salesforce."')
cue(21.95, 'window-in', lambda: whoosh(.8, 250, 2000, 600), .65, 0, 'Window in: Case record page')
cue(23.0, 'air', soft_air, .8, .2, 'Push in to the Nimbus panel')
for t0, note in [(24.35, 'Cut: assistant answer'), (26.95, 'Cut: Salesforce bell'), (28.95, 'Cut: approval on the record'), (30.75, 'Cut: the change with Undo')]: cue(t0, 'swish', swish, .5, 0, note)
cue(24.55, 'blip', blip, .6, .3, 'The answer appears')
cue(27.15, 'ding', ding, .65, .35, 'Approval in the bell')
cue(30.1, 'click', click, .9, .3, 'Click Approve (in Salesforce)')
cue(30.35, 'chime', chime, .6, .3, 'Approved')
cue(31.4, 'pop', lambda: pop(1200, 700, .07), .45, .3, 'Highlight on Medium → High · Undo')
cue(32.9, 'whoosh-out', lambda: whoosh(.6, 900, 2200, 400), .45, 0, 'Window leaves')

# Each person's access (33.4-36.6)
cue(33.35, 'window-in', lambda: whoosh(.8, 250, 2000, 600), .6, 0, 'Window in: Salesforce access')
cue(34.3, 'air', soft_air, .8, 0, 'Push in')
cue(36.1, 'whoosh-out', lambda: whoosh(.6, 900, 2200, 400), .4, 0, 'Window leaves')

# Build (36.6-44.4)
cue(36.55, 'swish', swish, .55, 0, '"Describe the job."')
cue(37.85, 'window-in', lambda: whoosh(.8, 250, 2000, 600), .6, 0, 'Window in: builder')
cue(39.55, 'click', click, .8, -.3, 'Click the request box')
for i in range(52): cue(39.7 + i * (1.7 / 52) + rng.uniform(-.01, .01), 'key', key, .55, -.3, 'Typing the request')
cue(41.65, 'whoosh-through', lambda: whoosh(.6, 400, 3000, 900), .55, 0, 'Zoom-through to the agent')
cue(42.4, 'air', soft_air, .8, 0, 'Push in to the steps')

# X-ray and proof (44.4-51.6)
cue(44.35, 'window-in', lambda: whoosh(.8, 250, 2000, 600), .6, 0, 'Window in: Automation X-ray')
cue(45.6, 'air', soft_air, .8, 0, 'Push in to conflicts')
cue(48.05, 'swish', swish, .5, 0, 'Cut: proof on real records')
cue(49.4, 'pop', lambda: pop(900, 600, .08), .45, 0, '88% agree')
cue(51.1, 'whoosh-out', lambda: whoosh(.6, 900, 2200, 400), .4, 0, 'Window leaves')

# Approve (51.6-59.2)
cue(51.55, 'swish', swish, .55, 0, '"Nothing changes until you say so."')
cue(53.05, 'window-in', lambda: whoosh(.8, 250, 2000, 600), .6, 0, 'Window in: Approvals')
cue(54.3, 'air', soft_air, .8, 0, 'Spotlight on the changes')
cue(55.7, 'click', click, .9, -.1, 'Click Approve')
cue(55.9, 'chime', chime, .7, -.1, 'Approved · 2 changes made')
cue(56.65, 'slack-in', lambda: whoosh(.7, 400, 2600, 800), .6, .5, 'Slack card slides in')
cue(58.1, 'click', click, .9, .5, 'Click Approve in Slack')
cue(58.25, 'chime', chime, .65, .5, 'Approved by Maria, in Slack')

# Your data (59.2-69.6)
cue(59.15, 'swish', swish, .55, 0, '"Your data stays yours."')
cue(60.55, 'window-in', lambda: whoosh(.8, 250, 2000, 600), .6, 0, 'Window in: Trust center')
cue(61.9, 'air', soft_air, .9, 0, 'Push in to masking')
cue(62.5, 'pop', lambda: pop(1200, 700, .07), .45, -.2, 'Ring on "Personal data is masked"')
cue(62.95, 'blip', blip, .45, .2, 'Email chip appears')
cue(63.45, 'glitch', glitch, 1.0, .2, 'Email scrambles into [EMAIL_1]')
cue(64.8, 'pop', lambda: pop(800, 1200, .08), .55, .2, '[EMAIL_1] settles')
cue(65.95, 'swish', swish, .5, 0, 'Cut: your own AI and a daily cap')
cue(69.1, 'whoosh-out', lambda: whoosh(.6, 900, 2200, 400), .4, 0, 'Window leaves')

# More than agents (69.6-80.2)
cue(69.55, 'swish', swish, .55, 0, '"And it does more than agents."')
for i, (t0, note) in enumerate([(70.95, 'Briefing'), (72.85, 'Dashboards'), (74.75, 'Memory'), (76.55, 'Discover'), (78.35, 'The return')]):
    cue(t0, 'side-whoosh', lambda i=i: whoosh(.55, 500, 3000, 900), .55, (.5 if i % 2 == 0 else -.5), f'Montage: {note}')

# Priced for the whole team + end card (80.2-90)
cue(80.15, 'whoosh-through', lambda: whoosh(.9, 300, 3200, 900), .6, 0, '"Priced for the whole team."')
cue(81.4, 'riser', riser, .5, 0, 'Lift into the end card')
cue(82.85, 'boom', boom, .95, 0, 'Logo hit')
cue(83.42, 'pop', lambda: pop(1100, 520, .1), .8, 0, 'The node drops in')
for i in range(6): cue(83.52 + i * .07, 'key', key, .4, -.3 + i * .12, 'Letters land')
cue(84.3, 'shimmer', shimmer, .7, 0, 'Tagline')
for i in range(3): cue(84.85 + i * .12, 'card-pop', lambda: pop(700, 420, .08), .5, -.4 + i * .4, 'Promise pills')
cue(85.65, 'pop', lambda: pop(500, 900, .14), .7, 0, 'Start free button')
cue(85.8, 'shimmer', shimmer, .5, 0, 'Button glow')


# ---------- render ----------
def place(buf, x, at, gain, pan):
    if x.ndim == 1:
        l, r = np.sqrt((1 - pan) / 2) * 1.41, np.sqrt((1 + pan) / 2) * 1.41
        x = np.stack([x * l, x * r], 1)
    i = int(at * SR); j = min(len(buf), i + len(x))
    if j > i: buf[i:j] += x[:j - i] * gain

def write(path, x):
    x = np.clip(x, -1, 1); pcm = (x * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

def bed():
    """A soft music bed: warm pads on Am–F–C–G, a gentle pulse while the product is on screen, a lift at the end."""
    N = int(DUR * SR); out = np.zeros((N, 2)); chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]]
    bar = 4.0  # seconds per chord
    hz = lambda m: 440 * 2 ** ((m - 69) / 12)
    for k in range(int(DUR / bar) + 1):
        st = k * bar; n = int((bar + 1.5) * SR); t = t_(bar + 1.5); ch = chords[k % 4]
        e = np.clip(t / 1.2, 0, 1) * np.clip((bar + 1.5 - t) / 1.5, 0, 1)
        sig = np.zeros((len(t), 2))
        for vi, m in enumerate(ch):
            for side, det in ((0, -0.08), (1, 0.08)):
                f = hz(m) * 2 ** (det / 12)
                v = sum(np.sin(2 * np.pi * f * h * t + vi) / h ** 1.6 for h in range(1, 7))
                sig[:, side] += v
        sig *= e[:, None] * .06
        place(out, sig, st, 1.0, 0)
        # bass
        b = np.sin(2 * np.pi * hz(ch[0] - 12) * t) * e * .07
        place(out, b, st, 1.0, 0)
    out = np.stack([fft_filter(out[:, 0], lowpass(2800)), fft_filter(out[:, 1], lowpass(2800))], 1)
    # pulse: soft kick on each beat (0.6 s) while product windows are on screen
    kick_t = t_(.35); kick = np.sin(2 * np.pi * np.cumsum(48 + 70 * np.exp(-kick_t * 30)) / SR) * env_exp(len(kick_t), .3) * .22
    hat = fft_filter(rng.standard_normal(int(.05 * SR)), highpass(7000)) * env_exp(int(.05 * SR), .02) * .04
    tt = 16.4
    while tt < 80.2:
        quiet = any(a <= tt < b for a, b in [(20.6, 22.0), (36.6, 37.9), (51.6, 53.1), (59.2, 60.6), (69.6, 71.0)])
        if not quiet:
            place(out, kick, tt, 1.0, 0); place(out, hat, tt + .3, 1.0, .2)
        tt += .6
    # overall shape: in from black, up for the end card, out at 90 s
    tl = np.arange(N) / SR
    shape = np.clip(tl / 2.5, 0, 1) * (0.75 + .25 * np.clip((tl - 80) / 3, 0, 1)) * np.clip((DUR - tl) / 2.2, 0, 1)
    return out * shape[:, None]

if __name__ == '__main__':
    N = int(DUR * SR); fx = np.zeros((N, 2))
    for at, name, fn, gain, pan, note in cues:
        place(fx, fn() if name in ('key', 'tick') else snd(name + str(id(fn)) if name in ('whoosh-in', 'whoosh-through', 'whoosh-out', 'window-in', 'slack-in', 'side-whoosh', 'card-pop', 'pop') else name, fn), at, gain, pan)
    fx = np.tanh(fx * 1.1) * .9
    b = bed()
    write('sfx.wav', fx); write('bed.wav', b); write('mix.wav', np.tanh((fx + b * .9) * 1.0) * .95)
    with open('cues.csv', 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['time', 'sound', 'note'])
        for at, name, fn, gain, pan, note in sorted(cues, key=lambda c: c[0]): w.writerow([f'{int(at // 60)}:{at % 60:05.2f}', name, note])
    print('cues', len(cues), '-> sfx.wav bed.wav mix.wav cues.csv')
