#!/usr/bin/env python3
"""process-reviews.py — Claude-side executor for the Dissertation Reviewer round-trip.

The web app queues review jobs into the private data repo (jobs.json) and writes the
comments into reviews/<chapter>.json. This script is what Claude runs to close the loop:

    list                 pull the data repo, show every queued job + its comments as a
                         changelist, and confirm the target .tex exists
    start  <job_id>      create/checkout branch  review-edits/<chapter>  in the
                         dissertation repo (off main) so edits can be made
    stage  <job_id>      AFTER the edits are committed + pushed on that branch, flip the
                         referenced comments to status='staged' (+ branch/ts) and mark the
                         job done, then commit + push the data repo

The actual LaTeX edits between `start` and `stage` are made by Claude by hand — this
script never invents edits. It only moves state and sets up the branch.

Paths are auto-detected but can be overridden with --data / --diss.
"""
import argparse, json, os, subprocess, sys, datetime, shutil

HOME = os.path.expanduser("~")
DEFAULT_DATA = os.path.join(HOME, "code", "put_github_repos_here", "dissertation-tracker-data")
DEFAULT_DISS = os.path.join(
    HOME, "GaTech Dropbox", "Matthew McCoy", "mattmccoy-research", "research",
    "dissertation_materials", "dissertation")

C = {"dim": "\033[2m", "b": "\033[1m", "y": "\033[33m", "g": "\033[32m",
     "c": "\033[36m", "r": "\033[31m", "x": "\033[0m"}


def sh(cmd, cwd, check=True):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f"{C['r']}$ {' '.join(cmd)}\n{r.stderr.strip()}{C['x']}")
    return r.stdout.strip()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def load(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        txt = f.read().strip()
    return json.loads(txt) if txt else default


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def pull(repo):
    if subprocess.run(["git", "remote", "get-url", "origin"], cwd=repo,
                      capture_output=True, text=True).returncode != 0:
        print(f"{C['dim']}({repo}: no origin remote — skipping pull){C['x']}")
        return
    r = subprocess.run(["git", "fetch", "origin"], cwd=repo, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"{C['y']}warning: could not fetch {repo} ({r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'offline'}){C['x']}")
        return
    branch = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo)
    sh(["git", "pull", "--ff-only", "origin", branch], repo, check=False)


def jobs_path(data):
    return os.path.join(data, "jobs.json")


def review_path(data, ch):
    return os.path.join(data, "reviews", f"{ch}.json")


def queued_jobs(data):
    return [j for j in load(jobs_path(data), []) if j.get("status") == "queued"]


def find_job(data, job_id):
    for j in load(jobs_path(data), []):
        if j.get("id") == job_id:
            return j
    sys.exit(f"{C['r']}job {job_id} not found in jobs.json{C['x']}")


def comments_for(data, job):
    review = load(review_path(data, job["chapter"]), {"comments": []})
    by_id = {c["id"]: c for c in review.get("comments", [])}
    return review, [by_id[i] for i in job.get("comment_ids", []) if i in by_id]


def tex_for(diss, ch):
    return os.path.join(diss, "chapters", f"{ch}.tex")


def cmd_list(a):
    pull(a.data)
    jobs = queued_jobs(a.data)
    if not jobs:
        print(f"{C['dim']}No queued jobs. (Click 'Send to Claude' in the app to queue one.){C['x']}")
        return
    print(f"{C['b']}{len(jobs)} queued job(s){C['x']}\n")
    for j in jobs:
        ch = j["chapter"]
        tex = tex_for(a.diss, ch)
        ok = "✓" if os.path.exists(tex) else f"{C['r']}MISSING{C['x']}"
        if j.get("type") == "run-agents":
            print(f"{C['c']}{j['id']}{C['x']}  {C['b']}{ch}{C['x']}  →  {C['y']}run agents{C['x']}: "
                  f"{', '.join(j.get('agents', []))}   on chapters/{ch}.tex {ok}")
            print(f"   {C['dim']}Run the agent(s) in-session on this chapter, then: "
                  f"process-reviews.py done {j['id']}{C['x']}\n")
            continue
        if j.get("type") == "merge":
            print(f"{C['c']}{j['id']}{C['x']}  {C['b']}{ch}{C['x']}  →  {C['g']}APPROVED — merge requested{C['x']}   review-edits/{ch} → main")
            print(f"   {C['dim']}Matt approved the staged edits. Run: process-reviews.py merge {ch}{C['x']}\n")
            continue
        review, cmts = comments_for(a.data, j)
        print(f"{C['c']}{j['id']}{C['x']}  {C['b']}{ch}{C['x']}  →  review-edits/{ch}   "
              f"target: chapters/{ch}.tex {ok}   ({len(cmts)} comment(s))")
        for c in cmts:
            tag = c.get("tag", "?")
            sec = c.get("anchor", {}).get("section", "")
            quote = (c.get("anchor", {}).get("quote", "") or "").replace("\n", " ")[:90]
            edit = c.get("edit")
            print(f"   {C['c']}{c['id']}{C['x']} {C['y']}[{tag}]{C['x']} {C['dim']}{sec}{C['x']}")
            print(f"      quote: “{quote}”")
            if edit:
                op = edit.get("op")
                print(f"      {C['r']}VERBATIM {op.upper()} — apply this EXACT change; do NOT paraphrase or reinterpret.{C['x']}")
                print(f"        find:        “{(edit.get('find','') or '').replace(chr(10),' ')[:160]}”")
                if op == "delete":
                    print(f"        action:      delete the find text (and tidy surrounding punctuation/spacing)")
                elif op == "insert":
                    print(f"        insert AFTER find, verbatim: “{(edit.get('replacement','') or '')[:200]}”")
                else:
                    print(f"        replace with verbatim:       “{(edit.get('replacement','') or '')[:200]}”")
                if c.get("body", "").strip():
                    print(f"        note:        {c['body'].strip()}")
            else:
                print(f"      ask:   {c.get('body','').strip()}")
        print()
    print(f"{C['dim']}apply-edits → start <job> → edit → stage <job>   |   "
          f"question → respond <chapter> <comment_id> \"answer\"   |   run-agents → done <job>{C['x']}")


def cmd_start(a):
    pull(a.data)
    pull(a.diss)
    job = find_job(a.data, a.job_id)
    ch = job["chapter"]
    branch = f"review-edits/{ch}"
    existing = sh(["git", "branch", "--list", branch], a.diss)
    if existing:
        sh(["git", "checkout", branch], a.diss)
    else:
        sh(["git", "checkout", "-b", branch, "origin/main"], a.diss, check=False) or \
            sh(["git", "checkout", "-b", branch], a.diss)
    review, cmts = comments_for(a.data, job)
    print(f"{C['g']}On branch {branch}{C['x']} in {a.diss}")
    print(f"Edit {C['b']}chapters/{ch}.tex{C['x']} for these {len(cmts)} comment(s), commit, then:")
    print(f"  git push -u origin {branch}")
    print(f"  {sys.argv[0]} stage {a.job_id}")


def cmd_stage(a):
    pull(a.data)
    job = find_job(a.data, a.job_id)
    ch = job["chapter"]
    branch = f"review-edits/{ch}"
    # confirm the branch was pushed
    remote = sh(["git", "ls-remote", "--heads", "origin", branch], a.diss, check=False)
    if not remote:
        print(f"{C['r']}warning: {branch} not found on origin — push it before staging.{C['x']}")
        if not a.force:
            sys.exit("re-run with --force to stage anyway.")
    rp = review_path(a.data, ch)
    review = load(rp, None)
    if review is None:
        sys.exit(f"{C['r']}no review file at {rp}{C['x']}")
    ids = set(job.get("comment_ids", []))
    n = 0
    for c in review.get("comments", []):
        if c["id"] in ids and c.get("status") in ("queued", "open"):
            c["status"] = "staged"
            c.setdefault("claude", {})
            c["claude"]["branch"] = branch
            c["claude"]["ts"] = now()
            n += 1
    dump(rp, review)
    jobs = load(jobs_path(a.data), [])
    for j in jobs:
        if j.get("id") == a.job_id:
            j["status"] = "done"
            j["done_ts"] = now()
    dump(jobs_path(a.data), jobs)
    sh(["git", "add", "-A"], a.data)
    sh(["git", "commit", "-m", f"review: stage {ch} ({n} comment(s)) → {branch}"], a.data, check=False)
    push = subprocess.run(["git", "push", "origin", "HEAD"], cwd=a.data, capture_output=True, text=True)
    if push.returncode != 0:
        print(f"{C['y']}local status written, but push failed: "
              f"{push.stderr.strip().splitlines()[-1] if push.stderr.strip() else '?'} — retry `git -C {a.data} push`.{C['x']}")
    print(f"{C['g']}Staged {n} comment(s) for {ch} → {branch}; job {a.job_id} done.{C['x']}")
    print(f"{C['dim']}The app will show these as 'staged' with the branch on next open.{C['x']}")


def _push_data(a, msg):
    sh(["git", "add", "-A"], a.data)
    sh(["git", "commit", "-m", msg], a.data, check=False)
    push = subprocess.run(["git", "push", "origin", "HEAD"], cwd=a.data, capture_output=True, text=True)
    if push.returncode != 0:
        print(f"{C['y']}local change written, but push failed — retry `git -C {a.data} push`.{C['x']}")


def cmd_respond(a):
    """Answer a question-comment: set claude.response + status='answered'."""
    pull(a.data)
    rp = review_path(a.data, a.chapter)
    review = load(rp, None)
    if review is None:
        sys.exit(f"{C['r']}no review file at {rp}{C['x']}")
    hit = next((c for c in review.get("comments", []) if c["id"] == a.comment_id), None)
    if hit is None:
        sys.exit(f"{C['r']}comment {a.comment_id} not in {a.chapter}{C['x']}")
    hit.setdefault("claude", {})
    hit["claude"]["response"] = a.text
    hit["claude"]["ts"] = now()
    hit["status"] = "answered"
    dump(rp, review)
    _push_data(a, f"review: answer {a.comment_id} in {a.chapter}")
    print(f"{C['g']}Answered {a.comment_id}; the app shows it as 'answered' with your reply.{C['x']}")


def cmd_note(a):
    """Attach an explanation to a comment WITHOUT changing its status (e.g. how a staged edit was made)."""
    pull(a.data)
    rp = review_path(a.data, a.chapter)
    review = load(rp, None)
    if review is None:
        sys.exit(f"{C['r']}no review file at {rp}{C['x']}")
    hit = next((c for c in review.get("comments", []) if c["id"] == a.comment_id), None)
    if hit is None:
        sys.exit(f"{C['r']}comment {a.comment_id} not in {a.chapter}{C['x']}")
    hit.setdefault("claude", {})
    hit["claude"]["response"] = a.text
    hit["claude"]["ts"] = now()
    if a.before or a.after:                      # record the in-context diff the reviewer renders inline
        hit["staged_edit"] = {"before": a.before, "after": a.after}
    dump(rp, review)
    _push_data(a, f"review: note on {a.comment_id} in {a.chapter}")
    extra = " (+staged_edit diff)" if (a.before or a.after) else ""
    print(f"{C['g']}Noted {a.comment_id} (status kept as '{hit.get('status')}'){extra}; the app shows your explanation.{C['x']}")


def cmd_done(a):
    """Mark any job done (e.g. after running agents in-session)."""
    pull(a.data)
    jobs = load(jobs_path(a.data), [])
    if not any(j.get("id") == a.job_id for j in jobs):
        sys.exit(f"{C['r']}job {a.job_id} not found{C['x']}")
    for j in jobs:
        if j.get("id") == a.job_id:
            j["status"] = "done"
            j["done_ts"] = now()
    dump(jobs_path(a.data), jobs)
    _push_data(a, f"review: job {a.job_id} done")
    print(f"{C['g']}Job {a.job_id} marked done.{C['x']}")


def cmd_merge(a):
    """Approve a chapter: merge review-edits/<ch> -> main, regenerate + republish the chapter, mark its
    staged comments 'merged', close any merge job, and delete the branch."""
    ch = a.chapter
    branch = f"review-edits/{ch}"
    pull(a.diss)
    if not sh(["git", "rev-parse", "--verify", branch], a.diss, check=False) and \
       not sh(["git", "ls-remote", "--heads", "origin", branch], a.diss, check=False):
        sys.exit(f"{C['r']}no branch {branch} to merge{C['x']}")
    sh(["git", "checkout", "main"], a.diss)
    sh(["git", "pull", "--ff-only", "origin", "main"], a.diss, check=False)
    sh(["git", "fetch", "origin", branch], a.diss, check=False)
    m = subprocess.run(["git", "merge", "--no-ff", "-m", f"merge {branch}: reviewed RFAM-reviewer edits",
                        f"origin/{branch}" if "origin" in (sh(["git","branch","-r"],a.diss,check=False) or "") else branch],
                       cwd=a.diss, capture_output=True, text=True)
    if m.returncode != 0:
        subprocess.run(["git", "merge", "--abort"], cwd=a.diss, capture_output=True)
        sys.exit(f"{C['r']}merge failed (conflict) — resolve by hand:\n{m.stderr.strip()[-400:]}{C['x']}")
    p = subprocess.run(["git", "push", "origin", "main"], cwd=a.diss, capture_output=True, text=True)
    if p.returncode != 0:
        print(f"{C['y']}merged locally but push to main failed — retry `git -C '{a.diss}' push`.{C['x']}")
    # regenerate this chapter's reading HTML from the new main and republish it
    sh(["bash", "export/chapter-html.sh", ch], a.diss)
    src = os.path.join(a.diss, "export", "build", f"{ch}.html")
    if os.path.exists(src):
        shutil.copy(src, os.path.join(a.data, "content", f"{ch}.html"))
    # flip the chapter's staged/approved comments to merged
    rp = review_path(a.data, ch); review = load(rp, None); n = 0
    if review:
        for c in review.get("comments", []):
            if c.get("status") in ("staged", "approved"):
                c["status"] = "merged"; c.setdefault("claude", {})["branch"] = branch; n += 1
        dump(rp, review)
    jobs = load(jobs_path(a.data), [])
    for j in jobs:
        if j.get("type") == "merge" and j.get("chapter") == ch and j.get("status") == "queued":
            j["status"] = "done"; j["done_ts"] = now()
    dump(jobs_path(a.data), jobs)
    _push_data(a, f"merge {ch}: republish content, mark {n} comment(s) merged")
    sh(["git", "push", "origin", "--delete", branch], a.diss, check=False)
    sh(["git", "branch", "-D", branch], a.diss, check=False)
    print(f"{C['g']}Merged {branch} -> main, republished {ch}, marked {n} comment(s) merged, deleted the branch.{C['x']}")
    print(f"{C['dim']}Note: global search index not rebuilt (do a full make-search-index if a section's text changed materially).{C['x']}")


def advisor_path(data, advisor, ch):
    return os.path.join(data, "advisor", advisor, f"{ch}.json")


def cmd_advisor_list(a):
    """List comments advisors submitted, with any recorded resolution."""
    pull(a.data)
    base = os.path.join(a.data, "advisor")
    if not os.path.isdir(base):
        print(f"{C['dim']}No advisor comments yet.{C['x']}"); return
    for advisor in sorted(os.listdir(base)):
        adir = os.path.join(base, advisor)
        if not os.path.isdir(adir):
            continue
        for fn in sorted(f for f in os.listdir(adir) if f.endswith(".json")):
            ch = fn[:-5]
            for c in load(os.path.join(adir, fn), {"comments": []}).get("comments", []):
                res = c.get("resolution")
                tail = f" {C['g']}· resolved: {res.get('state')}{C['x']}" if res else ""
                print(f"{C['c']}{advisor}{C['x']}/{C['b']}{ch}{C['x']} {C['c']}{c['id']}{C['x']} "
                      f"{C['y']}[{c.get('tag','?')}]{C['x']} {C['dim']}{c.get('anchor',{}).get('section','')}{C['x']}{tail}")
                print(f"   quote: “{(c.get('anchor',{}).get('quote','') or '')[:90]}”")
                print(f"   body:  {c.get('body','').strip()}")
                if c.get("edit"):
                    e = c["edit"]; print(f"   edit:  {e.get('op')} → “{(e.get('replacement','') or '')[:80]}”")
    print(f"{C['dim']}Record one: process-reviews.py advisor-resolve <ID> <chapter> <comment_id> "
          f"<addressed|declined|noted> \"note\" [--before .. --after ..]{C['x']}")


def cmd_advisor_resolve(a):
    """Write how an advisor comment was addressed into their file (shown on their portal — keep the note plain, reviewer-facing)."""
    pull(a.data)
    p = advisor_path(a.data, a.advisor, a.chapter)
    data = load(p, None)
    if data is None:
        sys.exit(f"{C['r']}no advisor file at {p}{C['x']}")
    hit = next((c for c in data.get("comments", []) if c["id"] == a.comment_id), None)
    if hit is None:
        sys.exit(f"{C['r']}comment {a.comment_id} not found in {a.advisor}/{a.chapter}{C['x']}")
    hit["resolution"] = {"state": a.state, "note": a.note, "ts": now()}
    if a.before: hit["resolution"]["before"] = a.before
    if a.after:  hit["resolution"]["after"] = a.after
    dump(p, data)
    _push_data(a, f"resolution: {a.advisor} {a.chapter} {a.comment_id} ({a.state})")
    print(f"{C['g']}Recorded '{a.state}' on {a.advisor}/{a.chapter}/{a.comment_id}; the advisor sees it on their portal.{C['x']}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default=DEFAULT_DATA, help="local clone of dissertation-tracker-data")
    p.add_argument("--diss", default=DEFAULT_DISS, help="local clone of phd-dissertation")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="show queued jobs + comments").set_defaults(fn=cmd_list)
    sp = sub.add_parser("start", help="branch off main for a job"); sp.add_argument("job_id"); sp.set_defaults(fn=cmd_start)
    sp = sub.add_parser("stage", help="mark comments staged + job done"); sp.add_argument("job_id"); sp.add_argument("--force", action="store_true"); sp.set_defaults(fn=cmd_stage)
    sp = sub.add_parser("respond", help="answer a question-comment (status=answered)"); sp.add_argument("chapter"); sp.add_argument("comment_id"); sp.add_argument("text"); sp.set_defaults(fn=cmd_respond)
    sp = sub.add_parser("note", help="attach an explanation (+optional staged-edit diff) to a comment, keep its status"); sp.add_argument("chapter"); sp.add_argument("comment_id"); sp.add_argument("text"); sp.add_argument("--before", default=""); sp.add_argument("--after", default=""); sp.set_defaults(fn=cmd_note)
    sp = sub.add_parser("merge", help="merge review-edits/<ch> -> main, republish, mark merged"); sp.add_argument("chapter"); sp.set_defaults(fn=cmd_merge)
    sp = sub.add_parser("done", help="mark any job done (e.g. after run-agents)"); sp.add_argument("job_id"); sp.set_defaults(fn=cmd_done)
    sub.add_parser("advisor-list", help="list advisor-submitted comments + resolutions").set_defaults(fn=cmd_advisor_list)
    sp = sub.add_parser("advisor-resolve", help="record how an advisor comment was addressed"); sp.add_argument("advisor"); sp.add_argument("chapter"); sp.add_argument("comment_id"); sp.add_argument("state", choices=["addressed","declined","noted"]); sp.add_argument("note"); sp.add_argument("--before", default=""); sp.add_argument("--after", default=""); sp.set_defaults(fn=cmd_advisor_resolve)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
