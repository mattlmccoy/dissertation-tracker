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
import argparse, json, os, re, subprocess, sys, datetime, shutil, glob, secrets


def uniq():
    return secrets.token_hex(4)

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
        if j.get("type") == "export":
            tgt = "whole dissertation" if ch == "__all__" else ch
            print(f"{C['c']}{j['id']}{C['x']}  {C['b']}{tgt}{C['x']}  →  {C['y']}export{C['x']}: {', '.join(j.get('formats', []))}")
            print(f"   {C['dim']}Build it: process-reviews.py export {j['id']}{C['x']}\n")
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
    # self-heal on a rejected push: the browser may have committed to the data repo since our last
    # pull. Rebase onto the remote (our commit replays on top — no lost data) and retry, a few times.
    for attempt in range(4):
        push = subprocess.run(["git", "push", "origin", "HEAD"], cwd=a.data, capture_output=True, text=True)
        if push.returncode == 0:
            return
        rb = subprocess.run(["git", "pull", "--rebase", "origin", "HEAD"], cwd=a.data, capture_output=True, text=True)
        if rb.returncode != 0:
            subprocess.run(["git", "rebase", "--abort"], cwd=a.data, capture_output=True)
            print(f"{C['y']}push rejected and auto-rebase hit a conflict — resolve by hand: "
                  f"git -C {a.data} pull --rebase && git -C {a.data} push.{C['x']}")
            return
    print(f"{C['y']}local change written, but push still failing after retries — retry `git -C {a.data} push`.{C['x']}")


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


def cmd_decide(a):
    """Record an owner decision (approve|reject|revise) on a staged comment."""
    pull(a.data)
    rp = review_path(a.data, a.chapter); review = load(rp, None)
    if review is None: sys.exit(f"{C['r']}no review at {rp}{C['x']}")
    found = False
    for c in review.get("comments", []):
        if c.get("id") == a.comment_id:
            c["decision"] = a.decision
            if a.note: c["decision_note"] = a.note
            c["decision_ts"] = now(); found = True
    if not found: sys.exit(f"{C['r']}comment {a.comment_id} not found{C['x']}")
    dump(rp, review); _push_data(a, f"review: decide {a.comment_id} {a.decision}")
    print(f"{C['g']}Recorded {a.decision} on {a.comment_id}.{C['x']}")


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


def _clear_fig_cache(diss):
    # preprocess.py reuses export/build/figs/<name>.pdf.png if it exists, so a regenerated figure
    # PDF won't re-rasterize. Drop those cached PNGs (NOT the content-hashed tikz_*.png) so changed
    # figures rebuild. Tikz pics are keyed by content and invalidate themselves.
    for f in glob.glob(os.path.join(diss, "export", "build", "figs", "*.pdf.png")):
        try: os.remove(f)
        except OSError: pass


def cmd_merge(a):
    """Approve a chapter: merge review-edits/<ch> -> main, regenerate + republish the chapter, mark its
    staged comments 'merged', close any merge job, and delete the branch."""
    ch = a.chapter
    branch = f"review-edits/{ch}"
    pull(a.data)   # refresh the review/comment files before we flip statuses (avoid a stale-base whole-file write)
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
    _clear_fig_cache(a.diss)
    sh(["bash", "export/chapter-html.sh", ch], a.diss)
    src = os.path.join(a.diss, "export", "build", f"{ch}.html")
    if os.path.exists(src):
        shutil.copy(src, os.path.join(a.data, "content", f"{ch}.html"))
    prev = os.path.join(a.data, "preview", f"{ch}.html")   # published == staged now; drop the preview
    if os.path.exists(prev): os.remove(prev)
    # decision subset: prefer the merge job's explicit lists, else fall back to "all staged"
    job = next((j for j in load(jobs_path(a.data), []) if j.get("type") == "merge"
                and j.get("chapter") == ch and j.get("status") == "queued"), None)
    sel = (job or {}).get("decisions")
    rp = review_path(a.data, ch); review = load(rp, None); n = 0
    requeue = []
    if review:
        approved = set((sel or {}).get("approved", []))
        rejected = set((sel or {}).get("rejected", []))
        revise = {d["cid"]: d.get("note", "") for d in (sel or {}).get("revise", [])}
        for c in review.get("comments", []):
            if c.get("status") not in ("staged", "approved"): continue
            cid = c.get("id")
            if sel is None or cid in approved:
                c["status"] = "merged"; c.setdefault("claude", {})["branch"] = branch; n += 1
            elif cid in rejected:
                c["status"] = "declined"; c.pop("staged_edit", None)
            elif cid in revise:
                c["status"] = "queued"; c.pop("staged_edit", None)
                requeue.append((cid, revise[cid]))
            # undecided staged comments are left as-is for a later round
        dump(rp, review)
    # re-queue 'revise' comments as fresh apply-edits jobs carrying the note
    if requeue:
        jobs = load(jobs_path(a.data), [])
        for cid, note in requeue:
            jobs.append({"id": "j_" + uniq(), "type": "apply-edits", "chapter": ch,
                         "comment_ids": [cid], "revision": True, "revise_note": note,
                         "status": "queued", "requested_ts": now()})
        dump(jobs_path(a.data), jobs)
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


def cmd_preview(a):
    """Build the chapter HTML from review-edits/<ch> WITHOUT merging, and publish it to
    preview/<ch>.html so the reviewer can see the fully-rendered staged version (new figures
    and text) before approving. Leaves main untouched."""
    ch = a.chapter
    branch = f"review-edits/{ch}"
    pull(a.diss)
    if not sh(["git", "rev-parse", "--verify", branch], a.diss, check=False) and \
       not sh(["git", "ls-remote", "--heads", "origin", branch], a.diss, check=False):
        sys.exit(f"{C['r']}no branch {branch} to preview{C['x']}")
    cur = subprocess.run(["git", "branch", "--show-current"], cwd=a.diss, capture_output=True, text=True).stdout.strip() or "main"
    sh(["git", "fetch", "origin", branch], a.diss, check=False)
    sh(["git", "checkout", branch], a.diss)
    try:
        sh(["git", "merge", "--ff-only", f"origin/{branch}"], a.diss, check=False)
        _clear_fig_cache(a.diss)
        sh(["bash", "export/chapter-html.sh", ch], a.diss)
        src = os.path.join(a.diss, "export", "build", f"{ch}.html")
        if not os.path.exists(src):
            sys.exit(f"{C['r']}preview build produced no HTML for {ch}{C['x']}")
        os.makedirs(os.path.join(a.data, "preview"), exist_ok=True)
        shutil.copy(src, os.path.join(a.data, "preview", f"{ch}.html"))
    finally:
        sh(["git", "checkout", cur], a.diss, check=False)
    _push_data(a, f"preview: rendered staged {ch} from {branch}")
    print(f"{C['g']}Built preview/{ch}.html from {branch} — the reviewer's Preview button now shows the rendered staged version. main untouched.{C['x']}")


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


# ---------------- export: chapter / dissertation -> docx · pdf · md, with comments ----------------
AUTHOR_NAME = "Matthew McCoy"

def _chapter_order(diss):
    """chapter basenames in main.tex \\include order (for whole-dissertation export)."""
    try:
        main = re.sub(r"%.*", "", open(os.path.join(diss, "main.tex"), encoding="utf-8").read())
        return re.findall(r"\\include\{chapters/([^}]+)\}", main)
    except OSError:
        return []

def _gather_comments(data, ch, include_resolved=True, reviewers=None):
    """All reviewer comments for a chapter, attributed. Advisor files are the source of
    reviewer comments; owner-original comments (no from_advisor) ride along as the author's."""
    out = []
    base = os.path.join(data, "advisor")
    if os.path.isdir(base):
        for adv in sorted(os.listdir(base)):
            fp = os.path.join(base, adv, f"{ch}.json")
            if not os.path.exists(fp):
                continue
            for c in load(fp, {"comments": []}).get("comments", []):
                if c.get("status") not in ("submitted", "resolved", None) and not c.get("body"):
                    continue
                name = c.get("author") or adv
                if reviewers and name not in reviewers and adv not in reviewers:
                    continue
                if c.get("resolution") and not include_resolved:
                    continue
                out.append({"author": name, "date": c.get("created_ts"),
                            "quote": (c.get("anchor") or {}).get("quote", ""), "body": c.get("body", ""),
                            "edit": c.get("edit"), "resolution": c.get("resolution"), "kind": c.get("kind", "text")})
    rev = load(review_path(data, ch), {"comments": []})
    for c in rev.get("comments", []):
        if c.get("from_advisor"):
            continue  # already counted from the advisor file
        if reviewers and AUTHOR_NAME not in reviewers:
            continue
        if c.get("resolution") and not include_resolved:
            continue
        out.append({"author": AUTHOR_NAME, "date": c.get("created_ts"),
                    "quote": (c.get("anchor") or {}).get("quote", ""), "body": c.get("body", ""),
                    "edit": c.get("edit"), "resolution": c.get("resolution"), "kind": c.get("kind", "text")})
    return out

def _annex_md(ch, comments):
    lines = [f"# Reviewer comments — {ch}", ""]
    if not comments:
        lines.append("_No comments._"); return "\n".join(lines)
    for n, c in enumerate(comments, 1):
        who = c["author"] + (f", {c['date'][:10]}" if c.get("date") else "")
        lines.append(f"**{n}. [{who}]**" + (f' on *“{_norm_ws(c["quote"])[:90]}”*' if c.get("quote") else ""))
        lines.append("")
        lines.append(c.get("body", "") or "")
        e = c.get("edit")
        if e:
            lines.append(f"\n> _Suggested {e.get('op')}:_ “{e.get('find','')}” → “{e.get('replacement','')}”")
        r = c.get("resolution")
        if r:
            lines.append(f"\n> _{r.get('state')} by the author:_ {r.get('note','')}")
        lines.append("")
    return "\n".join(lines)

def _norm_ws(s):
    return re.sub(r"\s+", " ", (s or "").strip())

def _build_docx(diss, ch, comments, outpath):
    bd = os.path.join(diss, "export", "build"); os.makedirs(bd, exist_ok=True)
    tmp = os.path.join(bd, f"_exp_{ch}"); os.makedirs(tmp, exist_ok=True)
    env = dict(os.environ, OUTDIR=tmp)
    r = subprocess.run(["bash", "export/export-chapter.sh", ch], cwd=diss, env=env, capture_output=True, text=True)
    base = os.path.join(tmp, f"{ch}.docx")
    if r.returncode != 0 or not os.path.exists(base):
        raise RuntimeError(f"export-chapter.sh failed: {r.stderr.strip()[-300:]}")
    cj = os.path.join(tmp, "comments.json"); dump(cj, comments)
    a = subprocess.run(["python3", "export/annotate_docx.py", base, cj, outpath], cwd=diss, capture_output=True, text=True)
    if a.returncode != 0 or not os.path.exists(outpath):
        raise RuntimeError(f"annotate_docx failed: {a.stderr.strip()[-300:]}")
    return a.stdout.strip()

def _build_md(diss, ch, comments, outpath):
    bd = os.path.join(diss, "export", "build"); tmp = os.path.join(bd, f"_exp_{ch}")
    base = os.path.join(tmp, f"{ch}.docx")
    if not os.path.exists(base):
        _build_docx(diss, ch, comments, os.path.join(tmp, f"{ch}.annot.docx"))  # ensures base docx exists
    body = subprocess.run(["pandoc", base, "-t", "gfm", "--wrap=none"], cwd=diss, capture_output=True, text=True)
    md = (body.stdout or "") + "\n\n---\n\n" + _annex_md(ch, comments) + "\n"
    open(outpath, "w", encoding="utf-8").write(md)

def _ensure_full_pdf(diss):
    pdf = os.path.join(diss, "drafts", "local_build.pdf")
    stale = True
    if os.path.exists(pdf):
        srcs = subprocess.run(["bash", "-lc",
            'find main.tex references.bib preamble chapters sections appendices -name "*.tex" -newer "%s" 2>/dev/null | head -1' % pdf],
            cwd=diss, capture_output=True, text=True).stdout.strip()
        stale = bool(srcs)
    if stale:
        b = subprocess.run(["bash", "export/build-pdf.sh", pdf], cwd=diss, capture_output=True, text=True)
        if not os.path.exists(pdf):
            raise RuntimeError(f"build-pdf.sh produced no PDF: {b.stderr.strip()[-300:]}")
    return pdf

def _build_pdf(diss, ch, comments, outpath):
    from pypdf import PdfReader, PdfWriter
    bd = os.path.join(diss, "export", "build"); tmp = os.path.join(bd, f"_exp_{ch}"); os.makedirs(tmp, exist_ok=True)
    full = _ensure_full_pdf(diss)
    sl = subprocess.run(["python3", "export/pdf-chapter.py", full, ch], cwd=diss, capture_output=True, text=True)
    chpdf = os.path.join(diss, "..", "advisor_updates", "chapters", f"{ch}.pdf")
    chpdf = os.path.normpath(chpdf)
    if not os.path.exists(chpdf):
        raise RuntimeError(f"pdf-chapter.py produced no slice: {sl.stderr.strip()[-300:]}")
    writer = PdfWriter()
    for pg in PdfReader(chpdf).pages: writer.add_page(pg)
    if comments:                                   # typeset "Reviewer comments" annex, concatenated
        amd = os.path.join(tmp, "annex.md"); open(amd, "w", encoding="utf-8").write(_annex_md(ch, comments))
        apdf = os.path.join(tmp, "annex.pdf")
        subprocess.run(["pandoc", amd, "-o", apdf, "-V", "geometry:margin=1in"], cwd=diss, capture_output=True, text=True)
        if os.path.exists(apdf):
            for pg in PdfReader(apdf).pages: writer.add_page(pg)
    with open(outpath, "wb") as f: writer.write(f)

def cmd_export(a):
    """Build a queued export job: chapter (or whole dissertation) -> requested formats, with comments."""
    pull(a.data); pull(a.diss)
    job = find_job(a.data, a.job_id)
    if job.get("type") != "export":
        sys.exit(f"{C['r']}job {a.job_id} is not an export job{C['x']}")
    scope = job.get("chapter", "__all__")
    chapters = _chapter_order(a.diss) if scope == "__all__" else [scope]
    formats = job.get("formats") or ["docx", "pdf", "md"]
    opts = job.get("opts") or {}
    include_resolved = opts.get("resolved", True); reviewers = opts.get("reviewers")
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M")
    artifacts = []
    label = scope
    outroot = os.path.join(a.data, "exports", label); os.makedirs(outroot, exist_ok=True)
    for ch in chapters:
        comments = _gather_comments(a.data, ch, include_resolved, reviewers)
        builders = {"docx": _build_docx, "md": _build_md, "pdf": _build_pdf}
        for fmt in formats:
            if fmt not in builders: continue
            out = os.path.join(outroot, f"{ch}__{ts}.{fmt}")
            try:
                if fmt == "docx": _build_docx(a.diss, ch, comments, out)
                elif fmt == "md": _build_md(a.diss, ch, comments, out)
                elif fmt == "pdf": _build_pdf(a.diss, ch, comments, out)
                artifacts.append({"chapter": ch, "fmt": fmt, "path": os.path.relpath(out, a.data),
                                  "comments": len(comments)})
                print(f"{C['g']}built {fmt}: {os.path.relpath(out, a.data)} ({len(comments)} comment(s)){C['x']}")
            except Exception as e:
                print(f"{C['y']}{fmt} for {ch} failed: {e}{C['x']}")
    jobs = load(jobs_path(a.data), [])
    for j in jobs:
        if j.get("id") == a.job_id:
            j["status"] = "done"; j["done_ts"] = now(); j["artifacts"] = artifacts
    dump(jobs_path(a.data), jobs)
    _push_data(a, f"export: {label} ({', '.join(formats)}) — {len(artifacts)} artifact(s)")
    print(f"{C['g']}Export {a.job_id} done — {len(artifacts)} artifact(s) under exports/{label}/.{C['x']}")


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
    sp = sub.add_parser("preview", help="build review-edits/<ch> into preview/<ch>.html (no merge)"); sp.add_argument("chapter"); sp.set_defaults(fn=cmd_preview)
    sp = sub.add_parser("done", help="mark any job done (e.g. after run-agents)"); sp.add_argument("job_id"); sp.set_defaults(fn=cmd_done)
    sp = sub.add_parser("export", help="build a queued export job (chapter/dissertation -> docx·pdf·md with comments)"); sp.add_argument("job_id"); sp.set_defaults(fn=cmd_export)
    sp_decide = sub.add_parser("decide", help="record an owner decision on a staged comment"); sp_decide.add_argument("chapter"); sp_decide.add_argument("comment_id"); sp_decide.add_argument("decision", choices=["approve", "reject", "revise"]); sp_decide.add_argument("note", nargs="?", default=""); sp_decide.set_defaults(fn=cmd_decide)
    sub.add_parser("advisor-list", help="list advisor-submitted comments + resolutions").set_defaults(fn=cmd_advisor_list)
    sp = sub.add_parser("advisor-resolve", help="record how an advisor comment was addressed"); sp.add_argument("advisor"); sp.add_argument("chapter"); sp.add_argument("comment_id"); sp.add_argument("state", choices=["addressed","declined","noted"]); sp.add_argument("note"); sp.add_argument("--before", default=""); sp.add_argument("--after", default=""); sp.set_defaults(fn=cmd_advisor_resolve)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
