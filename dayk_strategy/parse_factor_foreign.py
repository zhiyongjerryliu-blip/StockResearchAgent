"""Parse already-downloaded SEC filings for observation signals (no network)."""
import json
import sys
from foreign_financials import asml, taiwan, inline

if __name__=='__main__':
    data=json.load(sys.stdin)
    parser={'ASML':asml,'TSM':taiwan,'UMC':taiwan,'GFS':inline}[data['record']['ticker']]
    print(json.dumps(parser(data['record'],data['raw']),ensure_ascii=False,allow_nan=False))
