"""Physics check for the directional-light 3D test.

Renders the MediaPipe canonical face mesh (cm units) lit by halves of a phone screen
(Lambertian OLED, camera at the top edge, face ~30 cm away) and compares it with a flat
print, a bent print and a tilted print. Reports the log-ratio maps at the landmark patches
the app samples, so the thresholds in analysis.js rest on numbers, not guesses.
"""
import numpy as np

V, F = [], []
for line in open(__file__.replace('sim_geometry.py', 'canonical_face_model.obj')):
    p = line.split()
    if not p:
        continue
    if p[0] == 'v':
        V.append([float(x) for x in p[1:4]])
    elif p[0] == 'f':
        F.append([int(x.split('/')[0]) - 1 for x in p[1:4]])
V = np.array(V)
F = np.array(F)

# iBUG-68 -> MediaPipe mesh index (common mapping)
MP68 = [162, 234, 93, 58, 172, 136, 149, 148, 152, 377, 378, 365, 397, 288, 323, 454, 389,
        71, 63, 105, 66, 107, 336, 296, 334, 293, 301,
        168, 197, 5, 4, 75, 97, 2, 326, 305,
        33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380,
        61, 39, 37, 0, 267, 269, 291, 405, 314, 17, 84, 181, 78, 82, 13, 312, 308, 317, 14, 87]

# vertex normals, oriented towards the viewer (+z)
fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
if fn[:, 2].mean() < 0:
    fn = -fn
vn = np.zeros_like(V)
for k in range(3):
    np.add.at(vn, F[:, k], fn)
vn /= np.linalg.norm(vn, axis=1, keepdims=True)

D = 30.0                      # camera to face centre (cm)
ZC = 4.0 + D                  # camera z (face model's mid depth is ~4)
SCREEN_W, SCREEN_H, GAP = 7.0, 15.4, 1.0   # S21 Ultra-ish, camera 1 cm above the screen
N_IMG = 128
FOCAL = 128 / 0.75 * (1 / 15.5) * D * 0.75  # face (15.5 cm) spans ~0.75 of the crop

def project(P):
    z = ZC - P[:, 2]
    return np.stack([N_IMG / 2 + FOCAL * P[:, 0] / z, N_IMG / 2 - FOCAL * P[:, 1] / z], 1)

def screen_points(region, n=24):
    if region in ('SA', 'SB'):
        n = 64                    # enough samples across each of the 8 bars
    xs = np.linspace(-SCREEN_W / 2, SCREEN_W / 2, n)
    ys = np.linspace(-GAP, -GAP - SCREEN_H, 2 * n)
    X, Y = np.meshgrid(xs, ys)
    m = np.ones_like(X, bool)
    if region == 'L':   m = X < 0      # the user's... whichever; the test only uses ratios
    if region == 'R':   m = X >= 0
    if region == 'T':   m = Y > -GAP - SCREEN_H / 2
    if region == 'B':   m = Y <= -GAP - SCREEN_H / 2
    if region in ('SA', 'SB'):
        # 8 vertical bars counted from the user's left edge (+X); SA = bars 0,2,4,6 white
        k = np.floor((SCREEN_W / 2 - X) / (SCREEN_W / 8)).clip(0, 7)
        m = (k % 2 == 0) if region == 'SA' else (k % 2 == 1)
    Q = np.stack([X[m], Y[m], np.full(m.sum(), ZC)], 1)
    return Q

def irradiance(P, N, region):
    Q = screen_points(region)
    d = Q[None, :, :] - P[:, None, :]          # point -> screen element
    r2 = (d ** 2).sum(-1)
    w = d / np.sqrt(r2)[..., None]
    cos_p = np.clip((w * N[:, None, :]).sum(-1), 0, None)
    cos_s = np.clip(w[..., 2], 0, None)        # screen normal is -z, w points +z towards it
    return (cos_p * cos_s / r2).sum(1)

def rasterize(Pv, Nv):
    """Per-pixel 3D position + normal by barycentric interpolation with a z-buffer."""
    uv = project(Pv)
    zbuf = np.full((N_IMG, N_IMG), -np.inf)
    P = np.full((N_IMG, N_IMG, 3), np.nan)
    Nn = np.full((N_IMG, N_IMG, 3), np.nan)
    for tri in F:
        a, b, c = uv[tri]
        x0, x1 = int(max(0, np.floor(min(a[0], b[0], c[0])))), int(min(N_IMG - 1, np.ceil(max(a[0], b[0], c[0]))))
        y0, y1 = int(max(0, np.floor(min(a[1], b[1], c[1])))), int(min(N_IMG - 1, np.ceil(max(a[1], b[1], c[1]))))
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-9:
            continue
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                px, py = x + 0.5, y + 0.5
                l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den
                l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den
                l3 = 1 - l1 - l2
                if min(l1, l2, l3) < -1e-6:
                    continue
                pz = l1 * Pv[tri[0], 2] + l2 * Pv[tri[1], 2] + l3 * Pv[tri[2], 2]
                if pz > zbuf[y, x]:
                    zbuf[y, x] = pz
                    P[y, x] = l1 * Pv[tri[0]] + l2 * Pv[tri[1]] + l3 * Pv[tri[2]]
                    n = l1 * Nv[tri[0]] + l2 * Nv[tri[1]] + l3 * Nv[tri[2]]
                    Nn[y, x] = n / np.linalg.norm(n)
    return P, Nn

def landmarks2d():
    return project(V)[MP68]

def patches(L):
    """Same patch layout as www/js/analysis.js (facePatches)."""
    p = lambda i: L[i]
    lerp = lambda a, b, t: a + (b - a) * t
    W = np.linalg.norm(p(16) - p(0))
    up = p(27) - p(8); up /= np.linalg.norm(up)
    out = {
        'foreheadC': (p(19) + p(24)) / 2 + up * 0.17 * W,
        'foreheadL': p(19) + up * 0.13 * W,
        'foreheadR': p(24) + up * 0.13 * W,
        'glabella': p(27),
        'noseBridge': lerp(p(27), p(30), 0.45),
        'noseTip': lerp(p(30), p(33), 0.3),
        'noseFlankL': lerp(lerp(p(28), p(30), 0.6), p(31), 0.55),
        'noseFlankR': lerp(lerp(p(28), p(30), 0.6), p(35), 0.55),
        'cheekL': (p(41) + p(2) + p(31)) / 3,
        'cheekR': (p(46) + p(14) + p(35)) / 3,
        'cheekOuterL': lerp((p(41) + p(2) + p(31)) / 3, p(1), 0.5),
        'cheekOuterR': lerp((p(46) + p(14) + p(35)) / 3, p(15), 0.5),
        'underEyeL': (p(40) + p(41)) / 2 - up * 0.07 * W,
        'underEyeR': (p(46) + p(47)) / 2 - up * 0.07 * W,
        'philtrum': lerp(p(33), p(51), 0.5),
        'chin': lerp(p(57), p(8), 0.5),
        'jawL': lerp(p(4), p(48), 0.45),
        'jawR': lerp(p(12), p(54), 0.45),
    }
    return out, W

def sample(img, pts, W):
    yy, xx = np.mgrid[0:N_IMG, 0:N_IMG]
    res = {}
    for k, (x, y) in pts.items():
        rad = (0.035 if 'nose' in k else 0.045) * W
        m = (xx + 0.5 - x) ** 2 + (yy + 0.5 - y) ** 2 <= rad ** 2
        vals = img[m]
        vals = vals[np.isfinite(vals)]
        res[k] = vals.mean() if len(vals) else np.nan
    return res

def render_case(name):
    if name == 'face':
        P, N = rasterize(V, vn)
    else:
        # a print of the same face: same 2D appearance, but the surface is a sheet
        P0, _ = rasterize(V, vn)
        mask = np.isfinite(P0[..., 0])
        yy, xx = np.mgrid[0:N_IMG, 0:N_IMG]
        # back-project pixel rays onto the sheet
        rx = (xx + 0.5 - N_IMG / 2) / FOCAL
        ry = -(yy + 0.5 - N_IMG / 2) / FOCAL
        if name == 'flat':
            z = np.full(rx.shape, 4.0)
            X, Y = rx * (ZC - z), ry * (ZC - z)
            Nn = np.broadcast_to([0, 0, 1.0], rx.shape + (3,)).copy()
        elif name.startswith('tilt'):
            a = np.radians(float(name[4:]))
            # plane through (0,0,4) with normal (sin a, 0, cos a): solve along the ray
            n = np.array([np.sin(a), 0, np.cos(a)])
            # ray: (rx*t, ry*t, ZC - t) with t = depth from camera
            t = (n[2] * (ZC - 4.0)) / (n[0] * rx + n[1] * ry + n[2])
            X, Y, z = rx * t, ry * t, ZC - t
            Nn = np.broadcast_to(n, rx.shape + (3,)).copy()
        elif name.startswith('bent'):
            R = float(name[4:])     # cylinder radius about the vertical axis, bulging towards camera
            # surface z = 4 + sqrt(R^2 - x^2) - R ; iterate the ray intersection
            t = np.full(rx.shape, ZC - 4.0)
            for _ in range(20):
                X = rx * t
                z = 4.0 + np.sqrt(np.clip(R * R - X * X, 0, None)) - R
                t = ZC - z
            X, Y = rx * t, ry * t
            nx = X / R
            Nn = np.stack([nx, np.zeros_like(nx), np.sqrt(1 - nx * nx)], -1)
        P = np.stack([X, Y, z], -1)
        P[~mask] = np.nan
        N = Nn
        N[~mask] = np.nan
    m = np.isfinite(P[..., 0])
    flatP, flatN = P[m], N[m]
    E = {}
    for reg in ['W', 'L', 'R', 'T', 'B', 'SA', 'SB']:
        img = np.full((N_IMG, N_IMG), np.nan)
        img[m] = irradiance(flatP, flatN, reg)
        E[reg] = img
    return E

pts, W = patches(landmarks2d())
names = list(pts)
xy = np.array([pts[k] for k in names])
xn = (xy[:, 0] - xy[:, 0].mean()) / W
yn = (xy[:, 1] - xy[:, 1].mean()) / W

def fit_resid(vals, quad):
    cols = [np.ones_like(xn), xn, yn]
    if quad:
        cols += [xn * xn, xn * yn, yn * yn]
    A = np.stack(cols, 1)
    ok = np.isfinite(vals)
    coef, *_ = np.linalg.lstsq(A[ok], vals[ok], rcond=None)
    r = vals - A @ coef
    return r, coef

def nose_step(h):
    """Step between the nose flanks beyond a smooth (quadratic-in-x) trend of the other points."""
    i_l, i_r = names.index('noseFlankL'), names.index('noseFlankR')
    others = [i for i, k in enumerate(names) if not k.startswith('nose')]
    A = np.stack([np.ones(len(others)), xn[others], yn[others], xn[others] ** 2], 1)
    coef, *_ = np.linalg.lstsq(A, h[others], rcond=None)
    pred = lambda i: coef @ [1, xn[i], yn[i], xn[i] ** 2]
    step = (h[i_r] - pred(i_r)) - (h[i_l] - pred(i_l))
    return step, coef[1]

for case in ['face', 'flat', 'tilt15', 'tilt30', 'bent12', 'bent8']:
    E = render_case(case)
    S = {k: sample(E[k], pts, W) for k in E}
    h = np.array([np.log(S['L'][k] / S['R'][k]) for k in names])
    v = np.array([np.log(S['T'][k] / S['B'][k]) for k in names])
    rh, _ = fit_resid(h, False); rhq, _ = fit_resid(h, True)
    rv, _ = fit_resid(v, False); rvq, _ = fit_resid(v, True)
    step, slope = nose_step(h)
    print(f"\n== {case}: h range {np.nanmin(h):+.3f}..{np.nanmax(h):+.3f}  v range {np.nanmin(v):+.3f}..{np.nanmax(v):+.3f}")
    print(f"   residual RMS  h plane {np.sqrt(np.nanmean(rh**2)):.4f} quad {np.sqrt(np.nanmean(rhq**2)):.4f} | "
          f"v plane {np.sqrt(np.nanmean(rv**2)):.4f} quad {np.sqrt(np.nanmean(rvq**2)):.4f}")
    print(f"   nose step {step:+.4f}  x-slope {slope:+.4f}  step*sign(slope) {step*np.sign(slope):+.4f}")
    if case == 'face':
        for k, a, b in zip(names, h, v):
            print(f"     {k:12s} h {a:+.3f}  v {b:+.3f}")


# ── fixture export for the Node tests (test/fixtures/sim.json.gz) ─────────────────
import gzip, json, sys
if len(sys.argv) > 1:
    out = {'n': N_IMG, 'focal': FOCAL, 'zc': ZC, 'planeZ': 4.0,
           'screen': {'w': SCREEN_W, 'h': SCREEN_H, 'gap': GAP},
           'landmarks': landmarks2d().round(3).tolist(), 'cases': {}}
    L_AMB = np.array([0.0, 0.7, 0.7]) / np.sqrt(0.98)   # ceiling light, in front and above
    for case in ['face', 'flat']:
        E = render_case(case)
        if case == 'face':
            P, N = rasterize(V, vn)
        else:
            N = np.where(np.isfinite(E['W'])[..., None], np.array([0, 0, 1.0]), np.nan)
        amb = np.clip((N * L_AMB).sum(-1), 0, None)
        # app pattern names: the sim's X<0 half is the user's right (HR), X>=0 the user's left (HL)
        maps = {'W': E['W'], 'HL': E['R'], 'HR': E['L'], 'HT': E['T'], 'HB': E['B'], 'SA': E['SA'], 'SB': E['SB'], 'AMB': amb}
        scale = np.nanmax(E['W'])
        enc = {}
        for k, m in maps.items():
            s = scale if k != 'AMB' else 1.0
            q = np.where(np.isfinite(m), np.round(np.clip(m / s, 0, 1) * 65000), 65535).astype(int)
            enc[k] = q.ravel().tolist()
        out['cases'][case] = enc
    with gzip.open(sys.argv[1], 'wt') as f:
        json.dump(out, f, separators=(',', ':'))
    print('wrote', sys.argv[1])
