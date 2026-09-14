// Charts and image exports stay local. Apply this after a figure's options so
// Plotly defaults or a caller's config cannot enable cloud sharing.
const CLOUD_BUTTONS = ["sendChartToCloud", "sendDataToCloud", "editInChartStudio"];
const cloudNames = new Set(CLOUD_BUTTONS.map(name => name.toLowerCase()));

function withoutCloudButtons(buttons) {
    if (!Array.isArray(buttons)) return buttons;
    return buttons.filter(button => !cloudNames.has(String(button?.name ?? button).toLowerCase()))
        .map(button => Array.isArray(button) ? withoutCloudButtons(button) : button);
}

export function localPlotlyConfig(config = {}) {
    return {
        ...config,
        showSendToCloud: false,
        plotlyServerURL: "",
        modeBarButtons: withoutCloudButtons(config.modeBarButtons ?? false),
        modeBarButtonsToAdd: withoutCloudButtons(config.modeBarButtonsToAdd ?? []),
        modeBarButtonsToRemove: [...new Set([...(config.modeBarButtonsToRemove ?? []), ...CLOUD_BUTTONS])],
    };
}
