package cz.m5cet.app.fn;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.VideoView;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Locale;
import java.util.function.Consumer;

/**
 * A function's sound or video (FnMedia in FnOutputs.tsx): a small player
 * over the output's bytes written to a file. Nothing is prepared before the
 * first tap — unless the message is fresh and the output asks to autoplay.
 */
final class FnMedia extends LinearLayout {
    /** Writes the bytes to a file (called off the main thread). */
    interface Source { File get() throws IOException; }

    private final Theme theme;
    private final boolean video;
    private final boolean loop;
    private final Source source;
    private final Consumer<String> failed;
    private final TextView play;
    private final SeekBar bar;
    private final TextView time;
    private final VideoView screen;
    private MediaPlayer player;
    private boolean preparing;
    private boolean broken;
    private int generation;
    private final Runnable tick = this::tick;

    FnMedia(Context c, Theme theme, JSONObject o, boolean autoplay, Source source, Consumer<String> failed) {
        super(c);
        this.theme = theme;
        this.video = o.optString("type").equals("video");
        this.loop = Boolean.TRUE.equals(o.opt("loop"));
        this.source = source;
        this.failed = failed;
        setOrientation(VERTICAL);
        String title = o.opt("title") instanceof String ? o.optString("title") : "";
        if (!title.isEmpty()) addView(text(title, "@onSurface", 14));

        play = text("▶", "@onPrimary", 16);
        play.setGravity(Gravity.CENTER);
        GradientDrawable round = new GradientDrawable();
        round.setShape(GradientDrawable.OVAL);
        round.setColor(theme.color("@primary"));
        play.setBackground(round);
        play.setContentDescription(Words.t(theme, "fnui.play"));
        play.setOnClickListener(v -> toggle());
        int size = theme.dp(40);

        if (video) {
            FrameLayout frame = new FrameLayout(c);
            screen = new VideoView(c);
            frame.addView(screen, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER));
            frame.addView(play, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
            frame.setBackgroundColor(0xFF000000);
            frame.setOnClickListener(v -> toggle());
            addView(frame, new LayoutParams(LayoutParams.MATCH_PARENT, theme.dp(200)));
            bar = null;
            time = null;
        } else {
            screen = null;
            LinearLayout row = new LinearLayout(c);
            row.setOrientation(HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.addView(play, new LayoutParams(size, size));
            bar = new SeekBar(c);
            bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
                @Override public void onProgressChanged(SeekBar s, int p, boolean user) { if (user && player != null && !preparing) player.seekTo(p); }
                @Override public void onStartTrackingTouch(SeekBar s) { }
                @Override public void onStopTrackingTouch(SeekBar s) { }
            });
            row.addView(bar, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
            time = text("", "@muted", 12);
            row.addView(time);
            addView(row);
        }
        if (autoplay) toggle();
    }

    private TextView text(String s, String token, float sp) {
        TextView t = new TextView(getContext());
        t.setText(s);
        t.setTextColor(theme.color(token));
        t.setTypeface(theme.typeface(false));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        return t;
    }

    private void toggle() {
        if (broken || preparing) return;
        if (video && screen.isPlaying()) { screen.pause(); shown(false); return; }
        if (video && player != null) { screen.start(); shown(true); return; }
        if (player != null) {
            if (player.isPlaying()) player.pause(); else player.start();
            shown(player.isPlaying());
            tick();
            return;
        }
        preparing = true;
        play.setText("…");
        int gen = generation;
        Api.background(() -> {
            try {
                File f = source.get();
                post(() -> { if (gen == generation) open(f); });
            } catch (IOException | RuntimeException | OutOfMemoryError e) {
                post(() -> { if (gen == generation) fail(String.valueOf(e.getMessage())); });
            }
        });
    }

    private void open(File f) {
        if (video) {
            screen.setOnPreparedListener(mp -> {
                player = mp;
                preparing = false;
                mp.setLooping(loop);
                screen.start();
                shown(true);
            });
            screen.setOnCompletionListener(mp -> shown(false));
            screen.setOnErrorListener((mp, what, extra) -> { fail("the video could not be played (" + what + "/" + extra + ")"); return true; });
            screen.setVideoPath(f.getPath());
            return;
        }
        MediaPlayer p = new MediaPlayer();
        player = p;
        p.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build());
        p.setLooping(loop);
        p.setOnPreparedListener(mp -> {
            preparing = false;
            bar.setMax(Math.max(0, mp.getDuration()));
            mp.start();
            shown(true);
            tick();
        });
        p.setOnCompletionListener(mp -> { shown(false); tick(); });
        p.setOnErrorListener((mp, what, extra) -> { fail("the audio could not be played (" + what + "/" + extra + ")"); return true; });
        try {
            p.setDataSource(f.getPath());
            p.prepareAsync();
        } catch (IOException | IllegalStateException e) {
            fail(String.valueOf(e.getMessage()));
        }
    }

    private void shown(boolean playing) {
        play.setText(playing ? "❚❚" : "▶");
        if (video) play.setVisibility(playing ? GONE : VISIBLE);
    }

    /** The position, four times a second while it plays. */
    private void tick() {
        removeCallbacks(tick);
        if (player == null || video || preparing) return;
        int pos = player.getCurrentPosition();
        bar.setProgress(pos);
        time.setText(clock(pos) + " / " + clock(player.getDuration()));
        if (player.isPlaying()) postDelayed(tick, 250);
    }

    private static String clock(int ms) {
        int s = Math.max(0, ms) / 1000;
        return String.format(Locale.ROOT, "%d:%02d", s / 60, s % 60);
    }

    private void fail(String why) {
        broken = true;
        preparing = false;
        play.setText("✕");
        play.setVisibility(VISIBLE);
        failed.accept(why);
        release();
    }

    /** Stops and lets go of the player (the next tap prepares it again). */
    void release() {
        generation++;
        removeCallbacks(tick);
        preparing = false;
        if (video) screen.stopPlayback();
        else if (player != null) player.release();
        player = null;
        if (!broken) shown(false);
    }
}
