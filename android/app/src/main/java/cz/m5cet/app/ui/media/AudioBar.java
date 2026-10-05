package cz.m5cet.app.ui.media;

import android.content.Context;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.MediaDataSource;
import android.media.MediaPlayer;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.Ui;

/**
 * A small player in a bubble (6.1): play / pause, position, time — for voice
 * messages, audio attachments and the recording behind a call transcript.
 * One plays at a time; the source is opened only when played.
 */
public final class AudioBar extends LinearLayout {
    public interface Source { MediaDataSource open() throws java.io.IOException; }

    private static AudioBar playing;

    private final ImageView button;
    private final SeekBar seek;
    private final TextView time;
    private final int fg;
    private Source source;
    private MediaPlayer player;
    private boolean prepared;
    private final Runnable tick = this::tick;

    public AudioBar(Context c, int fg, int accent) {
        super(c);
        this.fg = fg;
        setGravity(Gravity.CENTER_VERTICAL);
        setMinimumWidth(Ui.dp(c, 200));
        button = new ImageView(c);
        int s = Ui.dp(c, 36);
        button.setLayoutParams(new LayoutParams(s, s));
        button.setScaleType(ImageView.ScaleType.CENTER);
        button.setBackground(Ui.ripple(Ui.shape(Ui.alpha(accent, 0.18f), Ui.dp(c, 18), 0, 0), Ui.alpha(fg, 0.2f)));
        button.setOnClickListener(v -> toggle());
        addView(button);
        seek = new SeekBar(c);
        seek.setMax(1000);
        seek.setProgressTintList(android.content.res.ColorStateList.valueOf(accent));
        seek.setThumbTintList(android.content.res.ColorStateList.valueOf(accent));
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar b, int p, boolean user) { if (user && prepared) player.seekTo((int) ((long) player.getDuration() * p / 1000)); }
            @Override public void onStartTrackingTouch(SeekBar b) { }
            @Override public void onStopTrackingTouch(SeekBar b) { }
        });
        addView(seek, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        time = new TextView(c);
        time.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        time.setTextColor(Ui.alpha(fg, 0.8f));
        time.setText("0:00");
        addView(time);
        icon(false);
        setContentDescription(cz.m5cet.app.core.Texts.t("media.a11y.audio", "audio"));
    }

    public void set(Source s, long durationMs) {
        if (s == source) return;
        release();
        source = s;
        time.setText(durationMs > 0 ? fmt(durationMs) : "▶");
        seek.setProgress(0);
    }

    private void icon(boolean pause) {
        button.setImageDrawable(Icons.drawable(getContext(), pause ? "square" : "play", Ui.dp(getContext(), 18), fg));
        button.setContentDescription(pause ? cz.m5cet.app.core.Texts.t("media.a11y.pause", "pause") : cz.m5cet.app.core.Texts.t("media.a11y.play", "play"));
    }

    public void toggle() {
        if (player != null && player.isPlaying()) { player.pause(); icon(false); return; }
        if (playing != null && playing != this) playing.stop();
        playing = this;
        if (prepared) { player.start(); icon(true); tick(); return; }
        if (source == null) return;
        Io.bg(() -> {
            try {
                MediaPlayer p = new MediaPlayer();
                p.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                p.setDataSource(source.open());
                p.setOnCompletionListener(mp -> Io.main(() -> { icon(false); seek.setProgress(0); }));
                p.prepare();
                Io.main(() -> {
                    player = p;
                    prepared = true;
                    time.setText(fmt(p.getDuration()));
                    p.start();
                    icon(true);
                    tick();
                });
            } catch (Exception e) {
                Log.w("media", "cannot play: " + e.getMessage());
                Io.main(() -> time.setText("⚠"));
            }
        });
    }

    public void stop() { if (player != null && player.isPlaying()) player.pause(); icon(false); }

    private void tick() {
        if (player == null || !prepared) return;
        int d = Math.max(1, player.getDuration());
        seek.setProgress((int) ((long) player.getCurrentPosition() * 1000 / d));
        time.setText(fmt(player.isPlaying() ? player.getCurrentPosition() : d));
        if (player.isPlaying()) postDelayed(tick, 200);
    }

    public void release() {
        removeCallbacks(tick);
        if (player != null) { try { player.release(); } catch (RuntimeException ignored) { } }
        player = null;
        prepared = false;
        if (playing == this) playing = null;
        icon(false);
    }

    @Override protected void onDetachedFromWindow() { super.onDetachedFromWindow(); release(); }

    static String fmt(long ms) { long s = ms / 1000; return s / 60 + ":" + String.format(java.util.Locale.ROOT, "%02d", s % 60); }

    static { Color.class.getName(); }
}
