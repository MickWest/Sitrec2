import {utcDate} from "./utils";
import {GlobalDateTimeNode, Globals, guiShowHide, setRenderOne} from "./Globals";
import {viewControlLabel, viewMenuKey} from "./ViewUIBarMenus";
import {t} from "./i18n";

// This function adds two text elements to the provided viewUI. The first text element displays the current UTC time, and the second text element displays the local time based on the time zone offset from the GlobalDateTimeNode. Both text elements are updated every frame to reflect the current time. The position, size, color, and alignment of the text can be customized through the function parameters. Additionally, the y position of the second text element is dynamically updated to ensure it is correctly positioned below the first text element, even if the size of the text changes.
// This allows for a consistent layout regardless of the text size or viewUI dimensions.
// TODO: needs work when resizing the browser window or if the viewUI dimensions change dynamically, as the y position of the second text element is calculated based on the initial size and height of the viewUI. To make it more robust, you might want to add an event listener for window resize or viewUI dimension changes to recalculate the y position of the second text element accordingly. This would ensure that the time display remains correctly positioned even when the layout changes.


export function AddTimeDisplayToUI(viewUI, x, y, size, color, align = "center") {

    // Default ON, so every sitch looks exactly as it did before this was made
    // optional. Set (not ??=) per sitch load, like the other Show-menu display
    // toggles in CNodeLabels3D — a saved custom sitch then overrides it in
    // finishDeserialization, which runs after the sitch has been set up.
    Globals.showTimeDisplay = true;

    // Both lines read the flag every frame rather than being switched by the
    // menu's onChange. That keeps them in sync with whatever sets the global —
    // the menu, a restored save, the API — with no refresh hook to remember.
    viewUI.addText("videoTimeLabelUTC", "2022-08-18T07:16:15.540Z", x, y, size, color, align).update(function () {
        this.visible = Globals.showTimeDisplay;
        var nowDate = GlobalDateTimeNode.dateNow;
        this.text = utcDate(nowDate);
    });

    viewUI.addText("videoTimeLabelTZ", "", x, y + 100 * ((Math.abs(size)) / viewUI.heightPx + 2), size, color, align).update(function () {
        this.visible = Globals.showTimeDisplay;
        var nowDate = GlobalDateTimeNode.dateNow;

        this.y = (y + 100 * (Math.abs(size)+2) / viewUI.heightPx)/100; // PATCH Update y position to match the new text element

        this.text = formatDateToTimeZone(nowDate, GlobalDateTimeNode.getTimeZoneOffset()) +
            " " + GlobalDateTimeNode.getTimeZoneName();
    });

    addTimeDisplayMenu(viewUI);

//    viewUI.addInput("dateTimeStart", "dateTimeStart"); // Adding dateTimeStart as in input force this to update when dateTimeStart is updated
}

// The Show-menu row for the display above, created here so it exists exactly when
// the display does — a sitch with no time overlay (FLIR1) gets no toggle. Non-.perm(),
// so it is destroyed and rebuilt with the rest of the per-sitch menu contents.
// .shareAs() mirrors the SAME controller into the host view's header menu
// (src/ViewUIBarMenus.js), so there is only ever one flag and one onChange.
function addTimeDisplayMenu(viewUI) {
    const viewId = viewUI.overlayView?.id ?? "lookView";

    // Composed rather than translated, like the per-view night-sky rows: the
    // overlay follows whichever view it was attached to, so the view name is not
    // known until here. The header menu drops the suffix — the menu names the view.
    guiShowHide.add(Globals, "showTimeDisplay")
        .name(viewControlLabel(viewId, t("timeDisplay.thing")))
        .tooltip(t("timeDisplay.tooltip"))
        .listen()
        .onChange(() => setRenderOne(true))
        .shareAs(viewMenuKey(viewId, "timeDisplay"));
}


function formatDateToTimeZone(date, offsetHours) {
    // Convert the offset to milliseconds
    const offsetMilliseconds = offsetHours * 60 * 60 * 1000;

    // Apply the offset
    const localTime = date.getTime();
    const localOffset = date.getTimezoneOffset() * 60000; // getTimezoneOffset returns in minutes
    const utc = localTime + localOffset;
    const targetTime = new Date(utc + offsetMilliseconds);

    // Format the date
    const pad = num => num.toString().padStart(2, '0');
    const formattedDate =
        targetTime.getFullYear()+'-'+
        pad(targetTime.getMonth() + 1) + '-' +
        pad(targetTime.getDate());
    const formattedTime = pad(targetTime.getHours()) + ':' +
        pad(targetTime.getMinutes()) + ':' +
        pad(targetTime.getSeconds());

    return formattedDate + ' ' + formattedTime;
}
