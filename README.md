# 3D heart model for echocardiography teaching

Source code of two browser simulators for teaching transthoracic echocardiography and focused cardiac ultrasound,
built for the UTHSC nephrology fellowship's POCUS curriculum (the Nephrology POCUS Bench, Session 4).

© 2026 Ahmed Kabeil, MD. Third-party material keeps its own credit and licence (below).

| Folder | Simulator | Heart model |
|---|---|---|
| `cardiac-pocus-trainer/` | Cardiac POCUS Trainer: a beating 4D heart in a modelled chest; find the views, spot acquisition errors and pathology archetypes, colour Doppler, Apple Pencil probe control, structured-report panel | TTESim 4D voxel heart |
| `real-heart-probe-lab/` | Real Heart Probe Lab: every standard TTE window on one real human heart (static, diastolic) in the same chest | University of Minnesota Visible Heart Laboratories specimen HH289 |

Each folder mirrors the code of its published page: `index.html` (the page and its simulator definition), `sim-engine.js`
(PBSim, the shared probe/scan-plane engine) and, for the trainer, `bench-controls.js` (the console faders). The engine's
working copy lives in the curriculum repository (`bench/sim-engine.js`); the copies here are the versions each page runs.
three.js 0.160 (MIT) loads from jsDelivr at run time.

## What is deliberately not in this repository

This repository is public. The data files the pages load are not, and the pages will not run from this code alone:

- `sim-cardiac-heart.txt`: the TTESim heart volume. Used with the developer's permission for teaching; that permission is verbal and
  has not been confirmed for public redistribution.
- `sim-heart-real.txt`: the University of Minnesota heart. © Regents of the University of Minnesota; used with permission
  (confirmed by Dr. Kabeil, 24 Oct 2026). Keep this credit with the data wherever it goes. (The header comment in
  `real-heart-probe-lab/index.html` predates that confirmation.)
- `m3d/human_thorax.glb.js` and `m3d/lung.glb.js`: simplified copies of two Sketchfab models, credited below.
- `videos/`: the reference echo clips shown beside the trainer, some third-party and used with permission.

The published pages, which hold these files, are private to Dr. Kabeil and the people he shares them with.

## Credits and licences

- Heart (trainer): TTESim 4D heart model, used with permission.
- Heart (probe lab): University of Minnesota Visible Heart Laboratories, specimen HH289, reassembled from the TEE teaching set.
  © Regents of the University of Minnesota.
- Rib cage: "Human thorax" by Medulla, Sketchfab, CC BY 4.0
  (https://sketchfab.com/3d-models/human-thorax-4aba9b2ced344bdf8f09656c6a298b50). Changes: decompressed, simplified, quantized,
  scaled and positioned to the simulated chest.
- Lungs: "Lung model" by Nahiarapa, Sketchfab, CC BY 4.0
  (https://sketchfab.com/3d-models/lung-model-4a6ac26d9f6d4094ba8f38bf67f42209). Changes: decompressed, simplified, quantized,
  recoloured, scaled and positioned.
- three.js, MIT licence.

No open-source licence has been chosen for the code in this repository, so it is all rights reserved by default.
Educational simulation with modelled anatomy; not a diagnostic device. Findings are composite teaching archetypes, not patients.
