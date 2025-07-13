import {par} from "./par";
import {utcDate} from "./utils";
import {GlobalDateTimeNode} from "./Globals";

export function AddTimeDisplayToUI(viewUI, x, y, size, color, align = "center") {

    viewUI.addText("videoTimeLabelUTC", "2022-08-18T07:16:15.540Z", x, y, size, color, align).listen(par, "frame", function (v) {
        var nowDate = GlobalDateTimeNode.dateNow;
        this.text = utcDate(nowDate);
    });

    viewUI.addText("videoTimeLabelTZ", "", x, y + 100 * ((Math.abs(size)) / viewUI.heightPx + 2), size, "pink", align).listen(par, "frame", function (v) {
        var nowDate = GlobalDateTimeNode.dateNow;

        this.y = (y + 100 * (Math.abs(size)+2) / viewUI.heightPx)/100; // PATCH Update y position to match the new text element

        this.text = formatDateToTimeZone(nowDate, GlobalDateTimeNode.getTimeZoneOffset()) +
            " " + GlobalDateTimeNode.getTimeZoneName();
    });

    viewUI.addInput("dateTimeStart", "dateTimeStart"); // Adding dateTimeStart as in input force this to update when dateTimeStart is updated
}

export function AddTimeDisplayToUIOld(viewUI, x, y, size, color, align = "center") {

    viewUI.addText("videoTimeLabel", "2022-08-18T07:16:15.540Z", x, y, size, color, align).listen(par, "frame", function (v) {
        var nowDate = GlobalDateTimeNode.dateNow;

//        this.text = utcDate(nowDate) + "  (" + localDate(nowDate)+")"
        this.text = utcDate(nowDate) + "  (" +
            formatDateToTimeZone(nowDate, GlobalDateTimeNode.getTimeZoneOffset())
            +" "+GlobalDateTimeNode.getTimeZoneName()
            +")"
    })
    viewUI.addInput("dateTimeStart", "dateTimeStart") // Adding dateTimeStart as in input force this to update when dateTimeStart is updated
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