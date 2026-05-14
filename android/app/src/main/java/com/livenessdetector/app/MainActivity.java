package com.livenessdetector.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(BrightnessPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
