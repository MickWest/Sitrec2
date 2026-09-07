export const TRACKING_VIDEO_CASES = [
    {id: "acquire-track-offset", description: "Off-centre acquisition and stable lock, operator centering, then target-relative slew",
        commands: [{timeSeconds: 0, action: "offset", pixels: [35, -25]}, {timeSeconds: 2, action: "acquire"},
            {timeSeconds: 12, action: "center"}, {timeSeconds: 17, action: "offset", pixels: [-35, 20], slewSeconds: 1.5},
            {timeSeconds: 22, action: "center"}]},
    {id: "partial-acquisition", description: "Candidate lost during refinement, ground hold, manual reacquisition",
        commands: [{timeSeconds: 2, action: "acquire"}, {timeSeconds: 3.6, action: "confidence", value: 0},
            {timeSeconds: 9, action: "confidence", value: 1}, {timeSeconds: 12, action: "manual"},
            {timeSeconds: 14, action: "acquire"}]},
    {id: "coast-recover", description: "Two brief confidence losses with predictive coast and recovery before timeout",
        commands: [{timeSeconds: 2, action: "acquire"}, {timeSeconds: 12, action: "confidence", value: 0},
            {timeSeconds: 12.8, action: "confidence", value: 1}, {timeSeconds: 20, action: "confidence", value: 0},
            {timeSeconds: 21.2, action: "confidence", value: 1}]},
    {id: "loss-ground-hold", description: "Established track loses confidence, three flashes, fixed DEM ground hold, target leaves screen",
        commands: [{timeSeconds: 2, action: "acquire"}, {timeSeconds: 14, action: "confidence", value: 0}]},
    {id: "manual-takeover", description: "Established track released to manual following, then operator selects ground hold",
        commands: [{timeSeconds: 2, action: "acquire"}, {timeSeconds: 12, action: "manual"},
            {timeSeconds: 14, action: "offset", pixels: [45, 20], slewSeconds: 1.5}, {timeSeconds: 22, action: "ground"}]},
    {id: "gate-escape-retry", description: "Target leaves the expanding acquisition gate, flashing failure, then a successful retry",
        commands: [{timeSeconds: 2, action: "acquire"}, {timeSeconds: 2.5, action: "offset", pixels: [160, 0]},
            {timeSeconds: 12, action: "offset", pixels: [0, 0]}, {timeSeconds: 12, action: "manual"},
            {timeSeconds: 14, action: "acquire"}]},
];

export function trackingVideoProgram(definition, fps = 30) {
    let offset = [0, 0];
    const commands = definition.commands.flatMap(command => {
        if (command.action === "center") { offset = [0, 0]; return [command]; }
        if (command.action !== "offset") return [command];
        const before = offset; offset = command.pixels;
        if (!command.slewSeconds) return [command];
        const frames = Math.round(command.slewSeconds * fps);
        return Array.from({length: frames + 1}, (_, f) => {
            const t = f / frames, p = t*t*(3-2*t);
            return {action: "offset", timeSeconds: command.timeSeconds + f / fps,
                pixels: before.map((v, i) => v + (command.pixels[i] - v) * p)};
        });
    }).sort((a, b) => a.timeSeconds - b.timeSeconds);
    return {...definition, commands};
}
