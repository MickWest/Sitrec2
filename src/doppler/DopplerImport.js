// Deliberately explicit units and altitude datum: guessing ADS-B altitude units
// silently moves the inferred listener by kilometres.
export function parseFlightCSV(text) {
    const rows=[];
    let row=[], cell="", quoted=false;
    for (let i=0;i<=text.length;i++) {
        const c=text[i] ?? "\n";
        if (c==='"') {
            if (quoted && text[i+1]==='"') {cell+='"';i++;} else quoted=!quoted;
        } else if (!quoted && (c==="," || c==="\n")) {
            row.push(cell.trim());cell="";
            if(c==="\n") {if(row.some(Boolean)) rows.push(row);row=[];}
        } else if (c!=="\r") cell+=c;
    }
    if (quoted) throw new Error("Unclosed quote in flight CSV.");
    const header=rows.shift()?.map(s=>s.replace(/^\uFEFF/,""));
    const required=["flight","time","lat","lon","altitudeM"];
    if (!header || required.some(k=>!header.includes(k))) throw new Error(`CSV columns required: ${required.join(",")}. Altitude is metres HAE; time is ISO UTC or Unix seconds.`);
    const groups=new Map();
    for(const [index,r] of rows.entries()) {
        const o=Object.fromEntries(header.map((key,i)=>[key,r[i]]));
        const raw=o.time?.trim();
        const time=raw && Number.isFinite(Number(raw)) ? Number(raw) : /(?:Z|[+-]\d\d:\d\d)$/.test(raw ?? "") ? Date.parse(raw)/1000 : NaN;
        const p={time,lat:Number(o.lat),lon:Number(o.lon),altitudeM:Number(o.altitudeM)};
        if (!o.flight || required.some(k=>!o[k]) || !Object.values(p).every(Number.isFinite) || Math.abs(p.lat)>90 || Math.abs(p.lon)>180) throw new Error(`Invalid CSV row ${index+2}. Supply all fields and an explicit UTC time zone.`);
        for(const k of ["groundSpeedMS","headingDegrees","verticalSpeedMS"]) {
            if(o[k]!==undefined && o[k]!=="") {
                if(!Number.isFinite(Number(o[k]))) throw new Error(`Invalid ${k} on CSV row ${index+2}.`);
                p[k]=Number(o[k]);
            }
        }
        if(!groups.has(o.flight)) groups.set(o.flight,{id:o.flight,callsign:o.callsign ?? "",registration:o.registration ?? "",aircraftType:o.aircraftType ?? "",points:[]});
        groups.get(o.flight).points.push(p);
    }
    if (!groups.size) throw new Error("The CSV contains no flights.");
    if(rows.length>200000) throw new Error("Limit each import to 200,000 fixes. Filter the source data to your region and time first.");
    return [...groups.values()];
}

export function resultsCSV(results) {
    const quote=v=>'"'+String(v).replace(/"/g,'""')+'"';
    return ["latitude,longitude,altitudeHAE,score,recordingStartUTC,flights,fundamentalsHz",
        ...results.map(r=>[r.lat,r.lon,r.altitudeM,r.score,new Date(r.recordingStart*1000).toISOString(),
            r.events.map(e=>e.flight).join(";"),r.events.map(e=>e.frequency).join(";")].map(quote).join(","))].join("\n");
}
