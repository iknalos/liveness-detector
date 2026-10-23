"""End-to-end run of the real app in desktop Chrome with the virtual camera (virtualcam.js).

Register a live (3D-lit) face, verify it, then try the attacks: a different person, a flat
print of the registered face, a glossy print, and the face on a phone screen.
Needs: `npm install && npm run vendor`, Python Playwright, and Google Chrome.
Run from the repo root:  python test/e2e/run_e2e.py [--headed] [--out DIR]
"""
import argparse, functools, http.server, json, os, sys, threading, time, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = '/node_modules/@vladmandic/face-api/demo/sample6.jpg'
OWNER = {'img': SAMPLE, 'crop': [1287, 152, 587, 587]}
OTHER = {'img': SAMPLE, 'crop': [94, 387, 558, 558]}

CASES = [
    # (name, mode, camera config, expected result title)
    ('register owner (live)', 'register', {**OWNER, 'surface': 'face'}, 'Face registered'),
    ('verify owner (live)', 'verify', {**OWNER, 'surface': 'face'}, 'Identity verified'),
    ('owner in a lit room', 'verify', {**OWNER, 'surface': 'face', 'ambient': 0.3}, 'Identity verified'),
    ('different live person', 'verify', {**OTHER, 'surface': 'face'}, 'Different person'),
    ('matte print of owner', 'verify', {**OWNER, 'surface': 'flat'}, 'Liveness check failed'),
    ('glossy print of owner', 'verify', {**OWNER, 'surface': 'flat', 'glare': 0.03}, 'Liveness check failed'),
    ('owner on a phone screen', 'verify', {**OWNER, 'surface': 'flat', 'emission': 0.6, 'diffuse': 0.02, 'glare': 0.4}, 'Liveness check failed'),
]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--headed', action='store_true')
    ap.add_argument('--out', default=str(ROOT / 'test' / 'e2e' / 'out'))
    args = ap.parse_args()
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    srv = serve()
    base = f'http://127.0.0.1:{srv.server_address[1]}/www/index.html'
    vcam = (ROOT / 'test' / 'e2e' / 'virtualcam.js').read_text(encoding='utf-8')
    failures = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=not args.headed,
                                    args=['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
                                          '--enable-unsafe-swiftshader', '--disable-renderer-backgrounding',
                                          '--disable-background-timer-throttling'])
        ctx = browser.new_context(viewport={'width': 412, 'height': 900}, device_scale_factor=1)
        ctx.add_init_script(vcam)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and 'favicon' not in m.text and '404' not in m.text and errors.append(m.text))
        page.on('dialog', lambda d: (errors.append('dialog: ' + d.message), d.accept()))
        for i, (name, mode, cam, want) in enumerate(CASES):
            page.goto(base + '?vcam=' + urllib.parse.quote(json.dumps(cam)))
            btn = '#btn-register' if mode == 'register' else '#btn-verify'
            page.wait_for_selector(f'{btn}:not([disabled])', timeout=120000)
            t0 = time.time()
            page.click(btn)
            page.wait_for_selector('#screen-result.active', timeout=180000)
            title = page.inner_text('#result-title')
            checks = page.eval_on_selector_all('#result-checks .check-row',
                                               'rows => rows.map(r => r.innerText.replace(/\\s+/g, " ").trim())')
            ident = page.inner_text('#identity-block') if page.is_visible('#identity-block') else ''
            page.click('#btn-details')
            page.wait_for_timeout(300)
            report = json.loads(page.input_value('#diag-json'))
            page.screenshot(path=str(out / f'{i:02d}.png'), full_page=True)
            (out / f'{i:02d}.json').write_text(json.dumps(report, indent=1), encoding='utf-8')
            ok = title == want
            failures += not ok
            m = report['metrics']
            print(f"[{'ok' if ok else 'FAIL'}] {name}: '{title}' (want '{want}') in {time.time() - t0:.0f}s"
                  f" | score {report['score']} R2 {m.get('trackR2')} lag {m.get('lagMs')} clock {m.get('clock')}"
                  f" nose {m.get('noseStep')} relief {m.get('vResid')} chroma {m.get('stepChroma')}"
                  f" frames {m.get('frames')} {ident.replace(chr(10), ' ')}")
            for c in checks:
                print('      ', c)
            if mode == 'register' and title != want:
                print('registration failed; the rest would be meaningless'); failures += 1; break
        if errors:
            print('page errors:', *errors[:10], sep='\n  ')
        browser.close()
    srv.shutdown()
    sys.exit(1 if failures or errors else 0)


if __name__ == '__main__':
    main()
