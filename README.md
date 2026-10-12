# Multiview (Sine mod)

Standalone port of `src/js/17-multiview.js` from [z1n-k/zia](https://github.com/z1n-k/zia) (MIT).

Right-click a video, a video page, or a tab and choose **Add to Multiview**. Up to four
YouTube / Twitch / Kick / Vimeo / Dailymotion videos or live streams open as a grid in one tab.
When it's full the item becomes **Replace in Multiview**.

## Install
1. Push this folder to a GitHub repo.
2. In Sine's settings, enable installing JS from unofficial sources.
3. Add `your-user/your-repo` in Settings -> Sine Mods, then restart Zen.

## The Multiview page
The mod only builds the address; the grid itself is a static web page. By default it uses Zia's
hosted copy. To self-host, point the `mod.multiview.url` preference at your own page, which must
read its videos from the URL hash: `#~RRGGBB,kind:id@seconds;title,...`
(kinds: yt, tw, twv, twc, kick, vm, dm, file).

## Credits
Original code by z1n-k, MIT licensed. Keep their LICENSE alongside this one.
