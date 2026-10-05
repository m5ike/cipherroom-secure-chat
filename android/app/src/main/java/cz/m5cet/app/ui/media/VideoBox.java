package cz.m5cet.app.ui.media;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.SurfaceTexture;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.Ui;

/**
 * A video in its bubble (6.2): the first frame with a play button, played
 * in place on tap straight from the vault (a MediaDataSource that decrypts
 * as the player reads, like AudioBar) — no plaintext file. One plays at a
 * time; leaving the screen releases the player.
 */
public final class VideoBox extends FrameLayout implements TextureView.SurfaceTextureListener {
    private static VideoBox playing;

    private final TextureView video;
    private final ImageView poster, button;
    private final TextView time;
    private final int maxW;
    private AudioBar.Source source;
    private MediaPlayer player;
    private Surface surface;
    private boolean prepared, preparing, wanted;
    private float ratio = 16f / 9f;
    private long duration;
    private final Runnable tick = this::tick;

    public VideoBox(Context c, int maxWidthPx) {
        super(c);
        maxW = maxWidthPx;
        setClipToOutline(true);
        setBackground(Ui.shape(Color.BLACK, Ui.dp(c, 12), 0, 0));
        video = new TextureView(c);
        video.setSurfaceTextureListener(this);
        addView(video, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        poster = new ImageView(c);
        poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
        addView(poster, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        button = new ImageView(c);
        button.setScaleType(ImageView.ScaleType.CENTER);
        button.setImageDrawable(Icons.drawable(c, "play", Ui.dp(c, 26), Color.WHITE));
        button.setBackground(Ui.shape(0x99000000, Ui.dp(c, 28), 0, 0));
        addView(button, new LayoutParams(Ui.dp(c, 56), Ui.dp(c, 56), Gravity.CENTER));
        time = new TextView(c);
        time.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        time.setTextColor(Color.WHITE);
        time.setPadding(Ui.dp(c, 6), Ui.dp(c, 2), Ui.dp(c, 6), Ui.dp(c, 2));
        time.setBackground(Ui.shape(0x80000000, Ui.dp(c, 8), 0, 0));
        LayoutParams tl = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        tl.setMargins(0, 0, Ui.dp(c, 6), Ui.dp(c, 6));
        addView(time, tl);
        time.setVisibility(GONE);
        setOnClickListener(v -> toggle());
        setContentDescription(cz.m5cet.app.core.Texts.t("media.a11y.video", "video"));
    }

    public void set(AudioBar.Source s) {
        if (s == source) return;
        release();
        source = s;
    }

    /** The first frame, the size and the length (Previews.videoFrame). */
    public void frame(Bitmap first, int w, int h, long durationMs) {
        if (first != null) poster.setImageBitmap(first);
        if (w > 0 && h > 0) { ratio = w / (float) h; requestLayout(); }
        duration = durationMs;
        if (durationMs > 0) { time.setText(AudioBar.fmt(durationMs)); time.setVisibility(VISIBLE); }
    }

    @Override protected void onMeasure(int ws, int hs) {
        int avail = MeasureSpec.getMode(ws) == MeasureSpec.UNSPECIFIED ? maxW : Math.min(maxW, MeasureSpec.getSize(ws));
        int w = avail;
        int h = Math.round(w / Math.max(0.3f, ratio));
        int max = Ui.dp(getContext(), 340), min = Ui.dp(getContext(), 120);
        if (h > max) { h = max; w = Math.min(avail, Math.round(h * ratio)); }
        h = Math.max(min, h);
        super.onMeasure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY));
    }

    public void toggle() {
        if (player != null && player.isPlaying()) { pause(); return; }
        if (playing != null && playing != this) playing.pause();
        playing = this;
        wanted = true;
        if (prepared) { start(); return; }
        if (surface != null) prepare();
    }

    private void start() {
        player.start();
        poster.setVisibility(GONE);
        button.setVisibility(GONE);
        time.setVisibility(VISIBLE);
        tick();
    }

    public void pause() {
        wanted = false;
        if (player != null && player.isPlaying()) player.pause();
        button.setVisibility(VISIBLE);
    }

    private void prepare() {
        if (source == null || player != null || preparing) return;
        preparing = true;
        Surface target = surface;
        Io.bg(() -> {
            try {
                MediaPlayer p = new MediaPlayer();
                p.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build());
                p.setDataSource(source.open());
                p.setSurface(target);
                p.setOnVideoSizeChangedListener((mp, w, h) -> Io.main(() -> { if (w > 0 && h > 0) { ratio = w / (float) h; requestLayout(); } }));
                p.setOnCompletionListener(mp -> Io.main(() -> { wanted = false; button.setVisibility(VISIBLE); time.setText(AudioBar.fmt(duration)); }));
                p.prepare();
                Io.main(() -> {
                    preparing = false;
                    if (surface != target || !isAttachedToWindow()) { p.release(); return; }
                    player = p;
                    prepared = true;
                    if (duration <= 0) duration = p.getDuration();
                    if (wanted) start();
                });
            } catch (Exception e) {
                Log.w("media", "cannot play the video: " + e.getMessage());
                Io.main(() -> { preparing = false; time.setText("⚠"); time.setVisibility(VISIBLE); });
            }
        });
    }

    private void tick() {
        if (player == null || !prepared) return;
        time.setText(AudioBar.fmt(player.getCurrentPosition()) + " / " + AudioBar.fmt(Math.max(duration, player.getDuration())));
        if (player.isPlaying()) postDelayed(tick, 250);
    }

    public void release() {
        removeCallbacks(tick);
        if (player != null) { try { player.release(); } catch (RuntimeException ignored) { } }
        player = null;
        prepared = false;
        wanted = false;
        if (playing == this) playing = null;
        poster.setVisibility(VISIBLE);
        button.setVisibility(VISIBLE);
    }

    @Override protected void onDetachedFromWindow() { super.onDetachedFromWindow(); release(); }

    @Override public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) {
        surface = new Surface(st);
        if (wanted) prepare();
    }

    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture st) {
        release();
        if (surface != null) { surface.release(); surface = null; }
        return true;
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) { }
    @Override public void onSurfaceTextureUpdated(SurfaceTexture st) { }
}
