RUNNING THE SHOT-ARC PIPELINE ON THE PC (GPU)
=============================================
Goal: re-track every eligible shot (about 243) with the fine-tuned ball detector, using the GPU, then
copy the small result files back to the laptop for the arc analysis and the visual checks.

You need on the PC:
  - the repo (git clone / git pull of pool-league-stat-tracker); the code is in its shot-arc folder
  - the fine-tuned weights (best.pt from the training run)
  - the 5 original 4K recordings, about 60 GB (IMG_2482.MOV, IMG_2483.MOV, IMG_2769.MOV,
    IMG_2770.MOV, IMG_2932.MOV), copied from the laptop's Videos\pool-league-4k60 folder
  - the small data kit (shotarc-pc-kit.zip): the shot list, the video timing table, decoys.json
  - ffmpeg on PATH (winget install ffmpeg, then open a new terminal and check: ffmpeg -version)
  - about 5 GB free disk (frames are deleted after each shot with --delete-frames)

1. Unzip shotarc-pc-kit.zip into C:\shotarc_data and copy the five .MOV files into
   C:\shotarc_data\videos. Copy decoys.json from the kit into the repo's shot-arc folder.
   Put best.pt at shot-arc\adam-balldata\poolvision-ball-finetuned.pt.

2. In PowerShell, from the repo's shot-arc folder (edit the weights path if yours differs):

     $env:SHOTARC_STATE="C:\shotarc_data\full_state.json"
     $env:SHOTARC_EXPORT="C:\shotarc_data\pool-league-data (8).json"
     $env:SHOTARC_VIEWER_VIDEOS_JS="C:\shotarc_data\viewer-videos.js"
     $env:SHOTARC_4K_DIR="C:\shotarc_data\videos"
     $env:BALL_WEIGHTS="adam-balldata\poolvision-ball-finetuned.pt"
     $env:BALL_MIN_CONF="0.3"
     python run_pipeline.py --limit 300 --offset 0 --seed 7 --out pipeline_results_ft.json --delete-frames

   It should report about 243 eligible shots. The detector uses the GPU automatically. The
   confidence gate is deliberately loose (0.3): every detection's confidence is saved in the tracked
   files, so a stricter threshold can be chosen afterwards without re-running anything.
   If it stops partway, run the same command again with --offset set to the number of shots done.

3. Copy back to the laptop (they are small, a few MB together, fine to email):
     shot-arc\real_*-tracked.json      (one per shot)
     shot-arc\real_*-hoops.json        (one per shot)
     shot-arc\pipeline_results_ft.json
   Zip them first. On the laptop they go into a new folder shot-arc\ft_full\ and get analysed there.

Nothing in this changes the laptop's existing results.
