#!/usr/bin/env python3
"""Meshy AI pipeline: image -> mesh+remesh(30k quad)+texture -> rig -> animations.

Reads MESHY_API_KEY from env. Do not hardcode the key here.
"""
import base64
import json
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

API_KEY = os.environ["MESHY_API_KEY"]
BASE = "https://api.meshy.ai/openapi/v1"
HEADERS = {"Authorization": f"Bearer {API_KEY}"}
HEADERS_JSON = {**HEADERS, "Content-Type": "application/json"}

SRC_DIR = "/tmp/claude-0/-home-user/6a3e957b-ac53-5edf-b9f1-d04803cf82bd/scratchpad/personajes_armas"
OUT_DIR = "/tmp/claude-0/-home-user/6a3e957b-ac53-5edf-b9f1-d04803cf82bd/scratchpad/output"

# idle=0, dead=8, hit_reaction=178 are shared by all characters.
IDLE_ACTION = 0
DEAD_ACTION = 8
HIT_ACTION = 178

CHARACTERS = [
    {"file": "char_01.png", "slug": "01_knife", "weapon": "knife", "action_id": 4, "action_name": "Attack"},
    {"file": "char_02.png", "slug": "02_cowboy_sword", "weapon": "sword/machete", "action_id": 242, "action_name": "Charged_Slash"},
    {"file": "char_03.png", "slug": "03_cowboy_pirate_sword", "weapon": "cutlass", "action_id": 97, "action_name": "Left_Slash"},
    {"file": "char_04.png", "slug": "04_pirate_cutlass", "weapon": "cutlass", "action_id": 102, "action_name": "Sword_Judgment"},
    {"file": "char_05.png", "slug": "05_astronaut_wrench", "weapon": "wrench", "action_id": 4, "action_name": "Attack"},
    {"file": "char_06.png", "slug": "06_robot_baton", "weapon": "energy baton", "action_id": 92, "action_name": "Double_Combo_Attack"},
    {"file": "char_07.png", "slug": "07_reaper_scythe", "weapon": "scythe", "action_id": 99, "action_name": "Reaping_Swing"},
    {"file": "char_08.png", "slug": "08_king_scepter", "weapon": "scepter/mace", "action_id": 128, "action_name": "Heavy_Hammer_Swing"},
    {"file": "char_09.png", "slug": "09_agent_gun", "weapon": "gun", "action_id": 104, "action_name": "Side_Shot"},
    {"file": "char_10.png", "slug": "10_ice_sword", "weapon": "ice sword", "action_id": 242, "action_name": "Charged_Slash"},
    {"file": "char_11.png", "slug": "11_slime_mace", "weapon": "spiked mace", "action_id": 128, "action_name": "Heavy_Hammer_Swing"},
    {"file": "char_12.png", "slug": "12_devil_trident", "weapon": "trident", "action_id": 240, "action_name": "Thrust_Slash"},
    {"file": "char_13.png", "slug": "13_banana_katana", "weapon": "katana", "action_id": 97, "action_name": "Left_Slash"},
    {"file": "char_14.png", "slug": "14_shark_katana", "weapon": "serrated katana", "action_id": 102, "action_name": "Sword_Judgment"},
    {"file": "char_15.png", "slug": "15_gamer_katana", "weapon": "neon katana", "action_id": 92, "action_name": "Double_Combo_Attack"},
    {"file": "char_16.png", "slug": "16_ghost_lantern", "weapon": "lantern (no weapon)", "action_id": 28, "action_name": "Big_Wave_Hello"},
    {"file": "char_17.png", "slug": "17_diamond_mace", "weapon": "spiked mace", "action_id": 128, "action_name": "Heavy_Hammer_Swing"},
]

POLL_INTERVAL = 8
MESH_TIMEOUT = 900
RIG_TIMEOUT = 600
ANIM_TIMEOUT = 300


def log(slug, msg):
    print(f"[{time.strftime('%H:%M:%S')}] {slug}: {msg}", flush=True)


def image_to_data_uri(path):
    ext = "jpeg" if path.lower().endswith((".jpg", ".jpeg")) else "png"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return f"data:image/{ext};base64,{b64}"


def api_post(path, payload):
    r = requests.post(f"{BASE}/{path}", headers=HEADERS_JSON, data=json.dumps(payload), timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} failed {r.status_code}: {r.text[:500]}")
    return r.json()["result"]


def poll_task(path, task_id, timeout, slug, label):
    start = time.time()
    while True:
        r = requests.get(f"{BASE}/{path}/{task_id}", headers=HEADERS, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"GET {path}/{task_id} failed {r.status_code}: {r.text[:500]}")
        data = r.json()
        status = data.get("status")
        if status == "SUCCEEDED":
            log(slug, f"{label} SUCCEEDED ({data.get('consumed_credits', '?')} credits)")
            return data
        if status in ("FAILED", "CANCELED"):
            err = data.get("task_error", {}).get("message", "unknown error")
            raise RuntimeError(f"{label} {status}: {err}")
        if time.time() - start > timeout:
            raise TimeoutError(f"{label} timed out after {timeout}s (last status={status})")
        time.sleep(POLL_INTERVAL)


def download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    with open(dest, "wb") as f:
        f.write(r.content)
    return len(r.content)


def process_character(cfg, existing_mesh_task_id=None):
    slug = cfg["slug"]
    result = {"slug": slug, "weapon": cfg["weapon"], "stages": {}, "credits": 0, "files": {}}
    char_dir = os.path.join(OUT_DIR, slug)
    try:
        if existing_mesh_task_id:
            log(slug, f"reusing already-completed image-to-3d task {existing_mesh_task_id} (no re-charge)")
            mesh_task_id = existing_mesh_task_id
        else:
            # 1. Image to 3D: mesh -> remesh to 30k quad -> texture, in one call.
            log(slug, "submitting image-to-3d (mesh + quad remesh 30k + PBR texture)")
            data_uri = image_to_data_uri(os.path.join(SRC_DIR, cfg["file"]))
            mesh_task_id = api_post("image-to-3d", {
                "image_url": data_uri,
                "ai_model": "latest",
                "should_texture": True,
                "enable_pbr": True,
                "should_remesh": True,
                "topology": "quad",
                "target_polycount": 30000,
                "pose_mode": "a-pose",
                "target_formats": ["glb"],
            })
        mesh_data = poll_task("image-to-3d", mesh_task_id, MESH_TIMEOUT, slug, "mesh+remesh+texture")
        result["credits"] += mesh_data.get("consumed_credits", 0)
        result["stages"]["mesh"] = "ok"
        glb_url = mesh_data["model_urls"]["glb"]
        download(glb_url, os.path.join(char_dir, f"{slug}_mesh_textured_quad30k.glb"))
        result["files"]["mesh"] = f"{slug}_mesh_textured_quad30k.glb"

        # 2. Rig directly from the image-to-3d task (no re-upload needed).
        log(slug, "submitting rigging task")
        rig_task_id = api_post("rigging", {"input_task_id": mesh_task_id, "height_meters": 1.6})
        rig_data = poll_task("rigging", rig_task_id, RIG_TIMEOUT, slug, "rigging")
        result["credits"] += rig_data.get("consumed_credits", 0)
        result["stages"]["rig"] = "ok"
        rig_result = rig_data["result"]
        download(rig_result["rigged_character_glb_url"], os.path.join(char_dir, f"{slug}_rigged.glb"))
        result["files"]["rigged"] = f"{slug}_rigged.glb"

        basic = rig_result.get("basic_animations", {})
        if basic.get("walking_glb_url"):
            download(basic["walking_glb_url"], os.path.join(char_dir, f"{slug}_anim_walk.glb"))
            result["files"]["anim_walk"] = f"{slug}_anim_walk.glb"
        if basic.get("running_glb_url"):
            download(basic["running_glb_url"], os.path.join(char_dir, f"{slug}_anim_run.glb"))
            result["files"]["anim_run"] = f"{slug}_anim_run.glb"

        # 3. Extra animations: weapon-specific attack + death (walk/run come free from rigging).
        extra_anims = [
            ("attack", cfg["action_id"], cfg["action_name"]),
            ("dead", DEAD_ACTION, "Dead"),
        ]
        result["stages"]["animations"] = {}
        for key, action_id, action_name in extra_anims:
            try:
                log(slug, f"submitting animation '{action_name}' (action_id={action_id})")
                anim_task_id = api_post("animations", {"rig_task_id": rig_task_id, "action_id": action_id})
                anim_data = poll_task("animations", anim_task_id, ANIM_TIMEOUT, slug, f"animation:{action_name}")
                result["credits"] += anim_data.get("consumed_credits", 0)
                anim_url = anim_data["result"]["animation_glb_url"]
                fname = f"{slug}_anim_{key}_{action_name}.glb"
                download(anim_url, os.path.join(char_dir, fname))
                result["files"][f"anim_{key}"] = fname
                result["stages"]["animations"][key] = "ok"
            except Exception as e:
                log(slug, f"WARNING animation '{action_name}' failed: {e}")
                result["stages"]["animations"][key] = f"failed: {e}"

        result["status"] = "complete"
        log(slug, f"DONE - total credits consumed: {result['credits']}")
    except Exception as e:
        result["status"] = "failed"
        result["error"] = str(e)
        log(slug, f"FAILED: {e}")
        traceback.print_exc()
    return result


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    r = requests.get(f"{BASE}/balance", headers=HEADERS, timeout=30)
    log("ALL", f"starting balance: {r.json()}")

    skip_slugs = set(sys.argv[1:])
    todo = [cfg for cfg in CHARACTERS if cfg["slug"] not in skip_slugs]
    log("ALL", f"processing {len(todo)}/{len(CHARACTERS)} characters (skipping {sorted(skip_slugs)})")

    # These 5 already have a SUCCEEDED image-to-3d task from the interrupted run;
    # reuse them instead of paying for mesh generation again.
    RESUME_MESH_IDS = {
        "02_cowboy_sword": "019f41a7-6958-7988-b959-2261029e5e97",
        "03_cowboy_pirate_sword": "019f41a7-6978-725c-b631-611cf0d39755",
        "04_pirate_cutlass": "019f41a7-69bf-7988-b1f2-1e03189d3e84",
        "05_astronaut_wrench": "019f41a7-6a00-7cff-b57e-29fd00492a1c",
        "06_robot_baton": "019f41a7-69ef-7988-88d9-36d0d6a4286b",
    }

    results = []
    with ThreadPoolExecutor(max_workers=5) as ex:
        futures = {
            ex.submit(process_character, cfg, RESUME_MESH_IDS.get(cfg["slug"])): cfg["slug"]
            for cfg in todo
        }
        for fut in as_completed(futures):
            results.append(fut.result())

    r = requests.get(f"{BASE}/balance", headers=HEADERS, timeout=30)
    log("ALL", f"ending balance: {r.json()}")

    summary_path = os.path.join(OUT_DIR, "summary.json")
    existing = []
    if os.path.exists(summary_path):
        with open(summary_path) as f:
            existing = json.load(f)
    existing = [x for x in existing if x["slug"] not in {r["slug"] for r in results}]
    results = existing + results
    with open(summary_path, "w") as f:
        json.dump(results, f, indent=2)

    ok = [x for x in results if x["status"] == "complete"]
    failed = [x for x in results if x["status"] != "complete"]
    log("ALL", f"FINISHED: {len(ok)} complete, {len(failed)} failed. Total credits: {sum(x['credits'] for x in results)}")
    for x in failed:
        log("ALL", f"  failed: {x['slug']} -> {x.get('error')}")


if __name__ == "__main__":
    main()
