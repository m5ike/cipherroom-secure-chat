package cz.m5cet.app.fn;

import java.util.HashMap;
import java.util.Map;

/** The words the outputs use: the app's translation (Theme.text), else the web's English (client/src/lib/i18n.ts). */
final class Words {
    private Words() {}

    private static final Map<String, String> EN = new HashMap<>();

    static {
        EN.put("fnui.submit", "Send");
        EN.put("fnui.sending", "Sending…");
        EN.put("fnui.sent", "Sent");
        EN.put("fnui.required", "Required");
        EN.put("fnui.invalid", "Not a valid value");
        EN.put("fnui.email", "Enter an e-mail address");
        EN.put("fnui.number", "Enter a number");
        EN.put("fnui.incomplete", "Fill in the whole value");
        EN.put("fnui.choose", "Choose…");
        EN.put("fnui.confirm", "Sure?");
        EN.put("fnui.noEvent", "This model does not answer {what}.");
        EN.put("fnui.what.button", "buttons");
        EN.put("fnui.what.form", "forms");
        EN.put("fnui.renderFailed", "This part of the result could not be shown ({message}).");
        EN.put("fnui.play", "Play");
        EN.put("fnui.download", "Download");
        EN.put("fnui.open", "Open");
        EN.put("fnui.webOnly", "Opens in the web app");
        EN.put("functions.send", "Send");
        EN.put("functions.cancel", "Cancel");
    }

    /** The text of key, with {name} filled from pairs ("what", "buttons", …). */
    static String t(Theme theme, String key, String... pairs) {
        String s = theme.text(key);
        if (s == null || s.equals(key)) s = EN.containsKey(key) ? EN.get(key) : key;
        for (int i = 0; i + 1 < pairs.length; i += 2) s = s.replace("{" + pairs[i] + "}", pairs[i + 1]);
        return s;
    }
}
