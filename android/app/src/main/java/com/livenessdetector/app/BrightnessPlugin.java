package com.livenessdetector.app;

import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Brightness")
public class BrightnessPlugin extends Plugin {

    @PluginMethod
    public void setBrightness(PluginCall call) {
        float brightness = call.getFloat("brightness", 1.0f);
        getActivity().runOnUiThread(() -> {
            WindowManager.LayoutParams lp = getActivity().getWindow().getAttributes();
            lp.screenBrightness = brightness;
            getActivity().getWindow().setAttributes(lp);
        });
        call.resolve();
    }

    @PluginMethod
    public void resetBrightness(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            WindowManager.LayoutParams lp = getActivity().getWindow().getAttributes();
            lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
            getActivity().getWindow().setAttributes(lp);
        });
        call.resolve();
    }
}
