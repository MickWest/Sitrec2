import {lookupNominatimLocation, selectNominatimLocation} from "../src/LocationSearch";

const garden = {
    name: "Geneva Botanic Garden", lat: "46.2293368", lon: "6.1475031",
    category: "leisure", type: "park", place_rank: 24, importance: 0.497261130845047,
    namedetails: {
        name: "Jardin botanique de Genève", "name:en": "Geneva Botanic Garden",
        alt_name: "Conservatoire et Jardin botaniques de Genève", short_name: "CJB",
        "alt_name:signed": "yes", "official_name:signed": "no",
    },
    address: {city: "Geneva", country: "Switzerland", country_code: "ch"},
};
const bingley = {
    name: "Bingley", lat: "53.85", lon: "-1.84", category: "place", type: "town",
    place_rank: 18, importance: 0.2, address: {country: "United Kingdom", country_code: "gb"},
};
const tinyPlace = {
    name: "Yes", lat: "46.4547538", lon: "13.5475507", category: "waterway", type: "stream",
    place_rank: 22, importance: 0.1067289776455329,
    address: {town: "Tarvisio", country: "Italy", country_code: "it"},
};
const hospital = {
    name: "Hôpitaux universitaires de Genève", lat: "46.1920030", lon: "6.1479499",
    category: "amenity", type: "hospital", place_rank: 30, importance: 0.4362884253550549,
    namedetails: {name: "Hôpitaux universitaires de Genève", short_name: "HUG"},
    address: {city: "Geneva", country: "Switzerland", country_code: "ch"},
};

test.each(["hug", "HUG"])("rejects the real hospital abbreviation %s without location context", query => {
    expect(selectNominatimLocation(query, [hospital])).toBeNull();
});

test.each(["HUG Geneva", "Hôpitaux universitaires de Genève"])("accepts a specific hospital request: %s", query => {
    expect(selectNominatimLocation(query, [hospital])).toEqual([46.192003, 6.1479499]);
});

test.each([
    ["amenity", "hospital"], ["shop", "clothes"], ["railway", "station"],
    ["office", "company"], ["aeroway", "aerodrome"], ["tourism", "hotel"], ["landuse", "industrial"],
])("a high importance score cannot make a bare word select a %s/%s facility", (category, type) => {
    expect(selectNominatimLocation("hug", [{...hospital, category, type, importance: 0.95}])).toBeNull();
});

test.each(["yes", "no", "yes Switzerland", "yes, Geneva"])(
    'rejects "%s" when the apparent match is a name metadata flag', query => {
        expect(selectNominatimLocation(query, [garden])).toBeNull();
    },
);

test.each(["Geneva Botanic Garden", "Jardin botanique de Geneve", "CJB", "Geneva Botanic Garden Switzerland"])(
    'accepts the actual name, translation, or short name "%s"', query => {
        expect(selectNominatimLocation(query, [garden])).toEqual([46.2293368, 6.1475031]);
    },
);

test.each(["NYC", "nyc", "New York City", "Big Apple"])("accepts genuine alternate names: %s", query => {
    const nyc = {
        ...bingley, name: "City of New York", lat: "40.71", lon: "-74.01",
        namedetails: {alt_name: "NYC;New York City", "alt_name:en": "Big Apple"},
    };
    expect(selectNominatimLocation(query, [nyc])).toEqual([40.71, -74.01]);
});

test("does not mistake a location code for a common word's actual name", () => {
    const airport = {...garden, name: "Yasuj Airport", namedetails: {iata: "YES", icao: "OISY"}};
    expect(selectNominatimLocation("yes", [airport])).toBeNull();
    expect(selectNominatimLocation("Yasuj Airport", [airport])).toEqual([46.2293368, 6.1475031]);
});

test("ignores unrelated address words for a bare name", () => {
    expect(selectNominatimLocation("yes", [{...garden, address: {hamlet: "yes"}}])).toBeNull();
});

test("rejects a tiny feature for a bare word, but accepts a qualified name", () => {
    expect(selectNominatimLocation("yes", [tinyPlace])).toBeNull();
    expect(selectNominatimLocation("Yes, Tarvisio", [tinyPlace])).toEqual([46.4547538, 13.5475507]);
});

test("does not reject a town solely because its importance is low", () => {
    expect(selectNominatimLocation("Bingley", [bingley])).toEqual([53.85, -1.84]);
});

test("a small hamlet remains searchable with its region", () => {
    const hamlet = {...tinyPlace, name: "Littleton", category: "place", type: "hamlet", place_rank: 20};
    expect(selectNominatimLocation("Littleton", [hamlet])).toBeNull();
    expect(selectNominatimLocation("Littleton Italy", [hamlet])).toEqual([46.4547538, 13.5475507]);
});

test("does not reject a prominent landmark because its place rank is small-scale", () => {
    expect(selectNominatimLocation("Stonehenge", [{...garden, name: "Stonehenge", place_rank: 30}]))
        .toEqual([46.2293368, 6.1475031]);
});

test("accepts a street address with customary abbreviations", () => {
    const house = {...tinyPlace, name: "Prime Minister's Office",
        display_name: "10 Downing Street, City of Westminster, Greater London, United Kingdom",
        address: {house_number: "10", road: "Downing Street", city: "City of Westminster", country_code: "gb"},
    };
    expect(selectNominatimLocation("10 Downing St, London, UK", [house])).toEqual([46.4547538, 13.5475507]);
});

test("skips a false match and selects a later real name match", () => {
    expect(selectNominatimLocation("Bingley", [garden, bingley])).toEqual([53.85, -1.84]);
});

test.each([null, {}, [], [{...bingley, lat: "invalid"}], [{...bingley, lat: 91}]])(
    "rejects missing or invalid results", results => {
        expect(selectNominatimLocation("Bingley", results)).toBeNull();
    },
);

test("requests name and address evidence, then filters before returning coordinates", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true, json: async () => [garden, tinyPlace],
    });
    try {
        expect(await lookupNominatimLocation(" yes ")).toBeNull();
        const url = new URL(fetchSpy.mock.calls[0][0]);
        expect(url.hostname).toBe("nominatim.openstreetmap.org");
        expect(Object.fromEntries(url.searchParams)).toEqual({
            format: "jsonv2", limit: "5", namedetails: "1", addressdetails: "1", q: "yes",
        });
    } finally { fetchSpy.mockRestore(); }
});

test("an unsuccessful lookup does not navigate", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({ok: false});
    try { expect(await lookupNominatimLocation("Bingley")).toBeNull(); }
    finally { fetchSpy.mockRestore(); }
});
