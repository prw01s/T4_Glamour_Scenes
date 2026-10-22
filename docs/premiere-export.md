# Preparing the day-to-night videos in Premiere Pro

A step-by-step guide for first-time Premiere users. It takes about 20 minutes.

## What you're making, and why

`day-to-night.html` plays two videos as one film. You'll make new copies of
both:

- **`study_day-night.mp4`**: the same film, re-saved so the browser can jump
  to any moment quickly. The current file has a single keyframe, a complete
  picture the browser can start decoding from, at the very start. To show a
  frame near the end, the browser decodes the whole clip first. The new file
  gets a keyframe every 6 frames, so jumps, stops and dragging the timeline are
  quick everywhere.
- **`study_night-to-day.mp4`**: exactly the same film played backwards. Today
  it's a separate render that looks slightly different, so the page has to
  crossfade every time it changes direction. An exact mirror makes the switch
  seamless.

You only need `study_day-night.mp4`, because the backwards copy is made from
it. The current files stay untouched. You'll export into a new folder, and they
are checked before they replace the old ones.

**Before you start**
- Premiere shows time as **hours:minutes:seconds:frames**, so `00:00:04:23` is
  4 seconds and 23 frames.
- The film runs at 24 frames per second, so it is 120 frames long:
  `00:00:00:00` to `00:00:04:23`.
- On a Mac keyboard without **Home** and **End** keys, use **Fn + ←** for
  Home and **Fn + →** for End.
- If a panel goes missing, use **Window > Workspaces > Reset to Saved Layout**.

---

## Part 1. Create a project and bring in the video

1. Open Premiere Pro. On the start screen, click **New project**.
2. The Import screen opens. Fill in the top of it:
   - **Project name:** `day-night-web`
   - **Project location:** click it and choose
     `T4_Glamour_Scenes/images/videos/premiere files`. Premiere keeps its
     working files next to the project, so this keeps them out of the
     website's folders.
3. In the left column, go to **T4_Glamour_Scenes > images > videos**. Click
   **`study_day-night.mp4`** once so it gets a blue tick. Select only this
   file.
4. On the right, make sure **Create new sequence** is switched on, and name it
   `study_day-night`.
5. Click **Create** (bottom right).

The editing screen opens:
- the picture is in the top right (the **Program Monitor**);
- the **Project** panel is in the bottom left;
- the **Timeline**, with your clip on it, is in the bottom right.

> Different start screen? Use **File > New > Project…**, then
> **File > Import…** (Cmd+I) to bring in the video. In the Project panel,
> right-click the video and choose **New Sequence From Clip**.
>
> Already in the editing screen with a sequence called **Sequence 01** that
> holds the clip? Then this part is done. In the Project panel, right-click
> **Sequence 01**, choose **Rename**, and call it `study_day-night`.

## Part 2. Tidy the day-to-night sequence

1. **Remove the sound.** In the Timeline, the clip is two strips: the upper one
   is **V1**, the video (blue or purple), and the lower one is **A1**, the
   audio (green).
   1. Right-click the clip and choose **Unlink**.
   2. Click an empty part of the Timeline.
   3. Click only the green audio strip and press **Delete**.

   Only the video strip should be left.
2. **Check the settings.** Choose **Sequence > Sequence Settings…** It should
   show:
   - **Timebase:** 24.00 frames/second
   - **Frame Size:** 1920 horizontal, 1080 vertical

   Click **Cancel** without changing anything. If it shows something else,
   such as 23.976, stop and ask before continuing.
3. **Check the length.** Click inside the Timeline and press **End**. The blue
   timecode at the top left of the Timeline should read **`00:00:05:00`**,
   the moment just after the last frame.

## Part 3. Make the backwards copy

1. In the Project panel, find the **sequence** named `study_day-night`. Its
   icon looks like a small timeline; the video file's icon is a film strip.
   Right-click the sequence and choose **Duplicate**. A copy named
   `study_day-night Copy` appears.
2. Right-click the copy, choose **Rename**, type `study_night-to-day` and press
   Return.
3. Right-click `study_night-to-day` and choose **Open in Timeline**.
   (Double-clicking its thumbnail also works; double-clicking its *name*
   starts renaming it instead, so press Esc if that happens.) It opens as a
   second tab in the Timeline; the tab's name shows which sequence you're
   editing.
4. In that Timeline, click the video clip once to select it.
5. Choose **Clip > Speed/Duration…** (Cmd+R) and set:
   - **Speed:** 100 % (leave it as it is)
   - **Reverse Speed:** ticked
   - **Ripple Edit** and **Maintain Audio Pitch:** unticked
   - **Time Interpolation:** **Frame Sampling**. The other options invent
     in-between pictures, and the copy would no longer be an exact mirror.

   Click **OK**. The clip's name now ends in `[-100%]`.
6. **Check it:**
   1. Press **Home**. The Program Monitor should show the night picture (the
      darkest one).
   2. Press **End**, then **←** once. It should show the bright morning
      picture.
   3. The timecode at End should still read `00:00:05:00`.
7. Save the project: **File > Save** (Cmd+S).

## Part 4. Export the first file

1. In the Timeline, click the **`study_day-night`** tab so it's the active
   sequence.
2. Click **Export** at the top left of the window (next to Import and Edit).
3. In the left column, make sure **Media File** is switched on. Leave the other
   destinations off.
4. Set the top of the settings:
   - **File Name:** `study_day-night` (Premiere adds `.mp4`).
   - **Location:** click the blue location text and go to
     **T4_Glamour_Scenes > images > videos**. Click **New Folder**, name it
     `export`, click **Create**, then click **Choose**.
   - **Preset:** **High Quality 1080p HD**. It changes to "Custom" once you
     change the settings below; that's expected.
   - **Format:** **H.264**.
5. Click **Video** to open that section. If you can't see every setting below,
   click **More** at the bottom of the section.
   - **Frame Size:** 1920 × 1080. **Frame Rate:** 24.
   - **Field Order:** Progressive. **Aspect:** Square Pixels (1.0).
   - **Performance:** **Software Encoding**. Hardware encoding is faster, but
     it ignores some of the settings below.
   - **Profile:** **Baseline**. If Baseline isn't in the list, choose **High**.
   - **Level:** **4.2**.
   - **Bitrate Encoding:** **VBR, 2 pass**.
   - **Target Bitrate:** **12** Mbps. **Maximum Bitrate:** **16** Mbps.
   - **Key Frame Distance:** tick it and type **6**. This is the most important
     setting.
6. **Audio:** untick the box next to the **Audio** heading. If there's no box,
   that's fine: the sequence has no sound now.
7. **Multiplexer:** **MP4**, Stream Compatibility **Standard**. This is
   usually already set.
8. **General:** leave **Use Previews** unticked.
9. Under the preview picture, set **Range** to **Entire Source**. The duration
   should read `00:00:05:00`.
10. (Optional) To reuse these settings for the second file, click the **…**
    next to Preset, choose **Save Preset**, and name it `Glamour web`.
11. Click **Export** (bottom right). It takes about a minute.

## Part 5. Export the second file

1. Click **Edit** at the top left.
2. In the Timeline, click the **`study_night-to-day`** tab.
3. Click **Export** again. Choose the `Glamour web` preset, or check that the
   settings from Part 4 are still there. Look especially at **Software
   Encoding**, **Baseline** and **Key Frame Distance 6**.
4. **File Name:** `study_night-to-day`. **Location:** the same `export` folder.
5. Click **Export**.
6. Back in Edit, save the project (Cmd+S).

## Part 6. Check the files

The two new files are in `images/videos/export/`. Ask Claude to check them, or
re-run the checks used in this project. Each file should have:

- 120 frames at 24 fps and no audio track;
- a keyframe every 6 frames, and no B-frames;
- for night-to-day, frame *k* matching frame 119 − *k* of day-to-night.

Then the files replace the ones in `images/videos/`, with the old ones kept as
a backup. With an exact mirror, the 400 ms crossfade in
`js/dayNightSequence.js` can be shortened or removed.

## If something goes wrong

| Problem | Fix |
| --- | --- |
| Baseline is missing or greyed out | Set **Performance** to **Software Encoding** first. |
| No **Key Frame Distance** setting | Click **More** at the bottom of the Video section. It's under Advanced Settings. |
| Duration reads `00:00:05:01` or longer | The audio strip is still in the sequence. Repeat Part 2, step 1. |
| The backwards copy looks blurry or jerky | Set Time Interpolation to **Frame Sampling** (Part 3, step 5). |
| The wrong sequence was exported | Export uses the sequence that was active when you clicked Export. Go back to Edit, click the right Timeline tab, and export again. |

## Sources

- Adobe, [Export settings reference for Media Encoder](https://helpx.adobe.com/media-encoder/using/export-settings-reference.html):
  Key Frame Distance; hardware vs software encoding; H.264 profiles.
- Adobe Community, [Key Frame Distance](https://community.adobe.com/t5/premiere-pro/key-frame-distance-please-help/td-p/8993448):
  it sets the GOP length; Premiere adds keyframes at scene changes.
- VideoHelp forum, [H.264 in Premiere: profiles and GOP structure](https://forum.videohelp.com/threads/413536-The-H264-Codec-in-Premiere-Pro-CS6-Creates-Files-with-Variable-Frame-Rates):
  Baseline exports have no B-frames; Main and High use them.
