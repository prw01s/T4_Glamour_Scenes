# Exporting the day-to-night videos from Premiere Pro

`day-to-night.html` plays `images/videos/study_day-night.mp4` and
`images/videos/study_night-to-day.mp4` as one film. Two things about how they
are exported decide how smooth it can be:

1. **Keyframe spacing (seeking speed).** To show any frame, the browser decodes
   forward from the previous keyframe. The current `study_day-night.mp4` has a
   single keyframe (frame 1), so seeking near its end decodes the whole clip:
   measured 75 ms, against 21 ms near the start. `study_night-to-day.mp4` has
   one every 47 frames (8–26 ms). Seeks happen on every direction change,
   every exact stop, and continuously while dragging the timeline.
2. **An exact reverse.** The page shows scene time *s* on the forward video at
   *s* and on the backward one at 5 − *s*. Today the two are separate renders
   that differ by about 6 levels at matching moments, so every switch needs a
   crossfade to hide the difference. If night-to-day is the forward video's
   frames in reverse order, switches are pixel-identical.

Target for both files: **H.264, 1920 × 1080, exactly 24 fps, 120 frames
(5.000 s), a keyframe every 6 frames, no B-frames, no audio.**

---

## A. Make night-to-day the exact reverse of day-to-night

Work from the Premiere project that produced the day-to-night clip (the
`images/videos/premiere files` folder), not from the exported MP4, so the
reverse isn't a re-compression of a compressed file.

1. **Check the day-to-night sequence settings.** Open the sequence, then
   **Sequence > Sequence Settings…**
   - Timebase: **24.00 frames/second** (not 23.976: the page assumes 24).
   - Frame Size: **1920 × 1080**, Pixel Aspect Ratio: **Square Pixels (1.0)**,
     Fields: **No Fields (Progressive Scan)**.
2. **Trim it to exactly 120 frames.** Set the In point on the first frame
   (`00:00:00:00`) and the Out point on `00:00:04:23` (the 120th frame), with
   **Markers > Mark In / Mark Out** (I / O). The current export runs 5.035 s,
   one frame's worth too long.
3. **Duplicate the sequence.** In the Project panel, right-click the sequence >
   **Duplicate**. Rename the copy `study_night-to-day`.
4. **Nest it.** Open the copy, select everything on the timeline (**Cmd+A**),
   right-click > **Nest…**, name it `day-to-night (nested)`, OK. The whole edit
   (clips, transitions, effects) is now one clip, so reversing it reverses the
   finished frames exactly.
5. **Reverse it.** Select the nested clip, then **Clip > Speed/Duration…**
   (Cmd+R):
   - Speed: **100 %** (Duration stays 00:00:05:00).
   - Tick **Reverse Speed**.
   - Time Interpolation: **Frame Sampling**. (Frame Blending or Optical Flow
     would invent new in-between frames, and the reverse would no longer
     match.)
   - OK.
6. **Set In and Out again** on this sequence: `00:00:00:00` to `00:00:04:23`.
7. **Check the ends.** The first frame of `study_night-to-day` must be the
   last frame (`00:00:04:23`) of the day-to-night sequence, and its last frame
   the first. Step through with the arrow keys in the Program Monitor, or use
   **Export Frame** (the camera icon) on both and compare.

## B. Export settings (use for both sequences)

With the sequence active, open **File > Export > Media…** (Cmd+M). Use the
**Export** workspace's settings, or click **More settings…** if your version
opens the simplified dialog.

1. **Format:** H.264. **Preset:** Custom (start from "Match Source – High
   bitrate" if you like, then change the settings below).
2. **Range:** Source In/Out (the 120 frames you marked).
3. **Video tab**
   - Frame Size: **1920 × 1080**. Frame Rate: **24**. Field Order:
     **Progressive**. Aspect: **Square Pixels (1.0)**.
   - **Encoding Settings**
     - Performance: **Software Encoding**. (Hardware encoding may ignore or
       grey out the options below; Premiere also switches to software by
       itself when hardware can't honour a setting.)
     - Profile: **Baseline**. Baseline doesn't allow B-frames, which is the
       only way to rule them out in Premiere (it has no B-frame setting).
       Its compression is a little less efficient, so it gets a bit more
       bitrate below. If Baseline isn't offered, use **High**: the keyframe
       distance (next) is the larger gain.
     - Level: **4.2**.
   - **Bitrate Settings**
     - Bitrate Encoding: **VBR, 2 pass**.
     - Target Bitrate: **12 Mbps**. Maximum Bitrate: **16 Mbps**. (The current
       files are about 9.5 Mbps. More keyframes and no B-frames need more
       bits for the same quality; expect files of about 8–10 MB each.)
   - **Advanced Settings**
     - Tick **Key Frame Distance** and set it to **6**. That is a keyframe
       every quarter second at 24 fps, so any frame is at most 5 frames from
       one. (Premiere may add extra keyframes at hard cuts; that's fine.)
   - Colour: **Rec. 709** output (the default for SD/HD), no HDR.
4. **Audio tab:** untick **Export Audio** (or set the audio track off). The
   page plays the videos muted, and the AAC audio track is the likely source
   of the extra 0.035 s on the current day-to-night file.
5. **Multiplexer tab:** MP4, Stream Compatibility: **Standard**.
6. Leave **Use Previews** unticked, so frames are rendered fresh.
7. **File names**: `study_day-night.mp4` (the day-to-night sequence) and
   `study_night-to-day.mp4` (the reversed one). **Export**, then replace the two
   files in `images/videos/`.

## C. After exporting

Ask Claude (or re-run the checks used in this project) to confirm:

- each file has 120 frames at 24 fps, 5.000 s, no audio track;
- the keyframe table lists a keyframe every 6 frames, and there are no B-frames;
- frame *k* of night-to-day matches frame 119 − *k* of day-to-night exactly.

Once the reverse is exact, the crossfade on every switch (400 ms in
`js/dayNightSequence.js`) can be shortened or dropped, and dragging along the
timeline becomes fluid on both videos.

## Sources

- Adobe, [Export settings reference for Media Encoder](https://helpx.adobe.com/media-encoder/using/export-settings-reference.html):
  Key Frame Distance; hardware vs software encoding; H.264 profiles.
- Adobe Community, [Key Frame Distance](https://community.adobe.com/t5/premiere-pro/key-frame-distance-please-help/td-p/8993448):
  it sets the GOP length; Premiere adds keyframes at scene changes.
- VideoHelp forum, [H.264 in Premiere: profiles and GOP structure](https://forum.videohelp.com/threads/413536-The-H264-Codec-in-Premiere-Pro-CS6-Creates-Files-with-Variable-Frame-Rates):
  Baseline exports have no B-frames; Main and High use them.
