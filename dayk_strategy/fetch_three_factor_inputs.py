"""Cache public split metadata and historical FX for a frozen research comparison."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'reports' / 'three_factor' / 'inputs'


def download(name, url):
    path = OUT / name
    if not path.exists():
        request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 Local Research Workbench'})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
        path.write_bytes(data)
    data = path.read_bytes()
    return {'file': name, 'url': url, 'sha256': hashlib.sha256(data).hexdigest()}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    protocol = json.loads((ROOT / 'industry18_protocol.json').read_text())
    requests = [(f'{ticker}_chart.json', f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=5y&interval=1d&events=div%2Csplits') for ticker in protocol['universe']]
    requests += [(f'{symbol}_chart.json', f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5y&interval=1d') for symbol in ['TWD=X', 'EURUSD=X']]
    manifests = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(download, name, url): name for name, url in requests}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            manifests.append(result)
            print('Cached ' + result['file'], flush=True)
    (OUT / 'manifest.json').write_text(json.dumps(sorted(manifests, key=lambda item: item['file']), indent=2))


if __name__ == '__main__':
    main()
