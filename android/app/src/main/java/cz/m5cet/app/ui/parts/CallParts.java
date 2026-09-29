package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;

import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoTrack;

import java.util.ArrayList;
import java.util.List;

import cz.m5cet.app.chat.Calls;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.rtc.Rtc;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/** The call's controls, its video tiles, and the download progress of an update. */
final class CallParts {
    private CallParts() {}

    static final class Controls extends LinearLayout implements Renderer.Slot {
        private final MainActivity a;
        private final ImageView mute, video, end;

        Controls(MainActivity a, Parts parts) {
            super(a);
            this.a = a;
            setGravity(Gravity.CENTER);
            mute = button("mic", 0x33FFFFFF, () -> a.action("call.mute", null, n -> null, this));
            video = button("video", 0x33FFFFFF, () -> a.action("call.video", null, n -> null, this));
            end = button("phone-off", Ui.color(a, "@danger", Color.RED), () -> a.action("call.end", null, n -> null, this));
        }

        private ImageView button(String icon, int bg, Runnable r) {
            ImageView b = new ImageView(getContext());
            int s = Ui.dp(getContext(), 64);
            LayoutParams lp = new LayoutParams(s, s);
            lp.setMargins(Ui.dp(getContext(), 12), 0, Ui.dp(getContext(), 12), 0);
            b.setScaleType(ImageView.ScaleType.CENTER);
            b.setImageDrawable(Icons.drawable(getContext(), icon, Ui.dp(getContext(), 26), Color.WHITE));
            b.setBackground(Ui.ripple(Ui.shape(bg, s / 2f, 0, 0), 0x44FFFFFF));
            b.setOnClickListener(v -> r.run());
            addView(b, lp);
            return b;
        }

        @Override public void bindSlot(Expr.Scope scope) {
            RoomSession r = a.app().rooms.activeSession();
            boolean muted = r != null && "muted".equals(r.calls().state());
            mute.setImageDrawable(Icons.drawable(getContext(), muted ? "mic-off" : "mic", Ui.dp(getContext(), 26), Color.WHITE));
            video.setAlpha(r != null && r.calls().video() ? 1f : 0.6f);
        }
    }

    /** Remote videos in a grid, our own camera in a corner. */
    static final class Video extends FrameLayout implements Renderer.Slot, Calls.VideoListener {
        private final MainActivity a;
        private final GridLayout grid;
        private final List<SurfaceViewRenderer> renderers = new ArrayList<>();
        private final List<VideoTrack> tracks = new ArrayList<>();
        private SurfaceViewRenderer local;
        private VideoTrack localTrack;

        Video(MainActivity a, Parts parts) {
            super(a);
            this.a = a;
            grid = new GridLayout(a);
            grid.setColumnCount(2);
            addView(grid, new LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            Calls.setVideoListener(this);
        }

        @Override public void onVideo(RoomSession room) { Io.main(() -> bindSlot(n -> null)); }

        private SurfaceViewRenderer renderer() {
            SurfaceViewRenderer r = new SurfaceViewRenderer(getContext());
            r.init(Rtc.egl().getEglBaseContext(), null);
            r.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL);
            r.setEnableHardwareScaler(true);
            return r;
        }

        @Override public void bindSlot(Expr.Scope scope) {
            RoomSession room = a.app().rooms.activeSession();
            if (room == null) return;
            List<VideoTrack> remote = room.calls().remoteVideos();
            if (!remote.equals(tracks)) {
                for (int i = 0; i < tracks.size(); i++) { try { tracks.get(i).removeSink(renderers.get(i)); } catch (RuntimeException ignored) { } renderers.get(i).release(); }
                grid.removeAllViews();
                renderers.clear();
                tracks.clear();
                int w = getWidth() > 0 ? getWidth() / (remote.size() > 1 ? 2 : 1) : ViewGroup.LayoutParams.MATCH_PARENT;
                for (VideoTrack t : remote) {
                    SurfaceViewRenderer r = renderer();
                    t.addSink(r);
                    GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
                    lp.width = w;
                    lp.height = remote.size() > 2 ? getHeight() / 2 : getHeight();
                    grid.addView(r, lp);
                    renderers.add(r);
                    tracks.add(t);
                }
            }
            VideoTrack mine = room.calls().localVideo();
            if (mine != localTrack) {
                if (local != null) { if (localTrack != null) localTrack.removeSink(local); removeView(local); local.release(); local = null; }
                localTrack = mine;
                if (mine != null) {
                    local = renderer();
                    local.setMirror(true);
                    local.setZOrderMediaOverlay(true);
                    mine.addSink(local);
                    LayoutParams lp = new LayoutParams(Ui.dp(getContext(), 110), Ui.dp(getContext(), 160), Gravity.BOTTOM | Gravity.END);
                    lp.setMargins(0, 0, Ui.dp(getContext(), 12), Ui.dp(getContext(), 12));
                    addView(local, lp);
                }
            }
        }

        @Override protected void onDetachedFromWindow() {
            Calls.setVideoListener(null);
            for (int i = 0; i < tracks.size(); i++) { try { tracks.get(i).removeSink(renderers.get(i)); } catch (RuntimeException ignored) { } renderers.get(i).release(); }
            if (local != null) { if (localTrack != null) localTrack.removeSink(local); local.release(); }
            super.onDetachedFromWindow();
        }
    }

    static final class Progress extends ProgressBar implements Renderer.Slot {
        Progress(MainActivity a, Parts parts) {
            super(a, null, android.R.attr.progressBarStyleHorizontal);
            setMax(1000);
        }
        @Override public void bindSlot(Expr.Scope scope) {
            Object u = scope.get("update");
            if (u instanceof org.json.JSONObject) setProgress((int) (((org.json.JSONObject) u).optDouble("progress", 0) * 1000));
        }
    }
}
