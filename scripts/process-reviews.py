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
import argparse, json, os, subprocess, sys, datetime

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
        review, cmts = comments_for(a.data, j)
        print(f"{C['c']}{j['id']}{C['x']}  {C['b']}{ch}{C['x']}  →  review-edits/{ch}   "
              f"target: chapters/{ch}.tex {ok}   ({len(cmts)} comment(s))")
        for c in cmts:
            tag = c.get("tag", "?")
            sec = c.get("anchor", {}).get("section", "")
            quote = (c.get("anchor", {}).get("quote", "") or "").replace("\n", " ")[:90]
            print(f"   {C['y']}[{tag}]{C['x']} {C['dim']}{sec}{C['x']}")
            print(f"      quote: “{quote}”")
            print(f"      ask:   {c.get('body','').strip()}")
        print()
    print(f"{C['dim']}Next: process-reviews.py start <job_id>  → make edits → "
          f"process-reviews.py stage <job_id>{C['x']}")


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


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default=DEFAULT_DATA, help="local clone of dissertation-tracker-data")
    p.add_argument("--diss", default=DEFAULT_DISS, help="local clone of phd-dissertation")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="show queued jobs + comments").set_defaults(fn=cmd_list)
    sp = sub.add_parser("start", help="branch off main for a job"); sp.add_argument("job_id"); sp.set_defaults(fn=cmd_start)
    sp = sub.add_parser("stage", help="mark comments staged + job done"); sp.add_argument("job_id"); sp.add_argument("--force", action="store_true"); sp.set_defaults(fn=cmd_stage)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
