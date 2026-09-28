
import json, os, collections
D = r"C:\dev\omo\omo-rollover\quota-test\2026-09-19"
rows = [json.loads(l) for l in open(os.path.join(D,"raw.jsonl"),encoding="utf8") if l.strip()]
msg = [r for r in rows if r.get("path")=="/v1/messages" and r.get("usage")]
def u5(r): return float(r["headers"]["anthropic-ratelimit-unified-5h-utilization"])
def u7(r): return float(r["headers"]["anthropic-ratelimit-unified-7d-utilization"])
def toks(r):
    u=r["usage"]; cc=u.get("cache_creation") or {}
    return dict(inp=u.get("input_tokens",0), w5=cc.get("ephemeral_5m_input_tokens",0),
                w1=cc.get("ephemeral_1h_input_tokens",0), rd=u.get("cache_read_input_tokens",0),
                out=u.get("output_tokens",0))
# tick events: consecutive /v1/messages rows where u5 or u7 changed
events=[]
prev=None
for r in msg:
    if prev and (u5(r)!=u5(prev) or u7(r)!=u7(prev)):
        events.append(dict(ts=r["ts"], label=r["label"], model=r["model"],
            du5=u5(r)-u5(prev), du7=u7(r)-u7(prev), u5=u5(r), u7=u7(r), toks=toks(r)))
    prev=r
print(json.dumps(events, indent=1))
