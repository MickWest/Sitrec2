import {NodeMan} from "./Globals";
import {applyGoToString} from "./GoTo";
import {showChoice, showPrompt} from "./showError";

export async function showGoToDialog() {
    let text = "";
    while (true) {
        const input = await showPrompt("Frame, date/time, coordinates, place name, or TLE. Combine a place and time, for example: Bingley, 10AM", {
            title: "Go To", defaultValue: text,
        });
        if (!input?.trim()) return;
        text = input.trim();
        if (await applyGoToString(text)) return;
        const chat = NodeMan.get("chatView", false);
        const choice = await showChoice(`Go To could not understand or find “${text}”.`, {
            title: "Go To",
            options: [
                ...(chat ? [{label: "Continue in Chat", value: "chat", primary: true, description: "Send this request to the Assistant."}] : []),
                {label: "Edit request", value: "edit", primary: !chat},
                {label: "Cancel", value: "cancel", cancel: true},
            ],
        });
        if (choice === "edit") continue;
        if (choice === "chat") {
            chat.setVisible(true);
            chat.setInputTextAndFocus("");
            await chat.submitMessage(text);
        }
        return;
    }
}
