import i18next from "i18next";
import en from "./en";
import es from "./es";
import fr from "./fr";
import de from "./de";
import pt from "./pt";
import it from "./it";
import ru from "./ru";
import ja from "./ja";
import nl from "./nl";
import zh from "./zh";

const FALLBACK_LANGUAGE = "en";
const LANGUAGE_STORAGE_KEY = "sitrec-language";
const SUPPORTED_LANGUAGES = [FALLBACK_LANGUAGE, "es", "fr", "de", "pt", "it", "ru", "ja", "nl", "zh"];
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const TRANSLATION_RESOURCES = Object.freeze({
    en,
    es,
    fr,
    de,
    pt,
    it,
    ru,
    ja,
    nl,
    zh,
});

export const SUPPORTED_LANGUAGE_OPTIONS = Object.freeze({
    English: "en",
    Español: "es",
    Français: "fr",
    Deutsch: "de",
    Português: "pt",
    Italiano: "it",
    Русский: "ru",
    日本語: "ja",
    Nederlands: "nl",
    中文: "zh",
});

let initialized = false;
const warnedMissingKeys = new Set();

function normalizeLanguage(language) {
    if (typeof language !== "string" || language.trim() === "") {
        return FALLBACK_LANGUAGE;
    }

    const normalized = language.toLowerCase().split("-")[0];
    return SUPPORTED_LANGUAGES.includes(normalized) ? normalized : FALLBACK_LANGUAGE;
}

function getStoredLanguage() {
    if (typeof window === "undefined" || !window.localStorage) {
        return null;
    }

    try {
        const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
        if (stored === null) return null;
        return normalizeLanguage(stored);
    } catch (_error) {
        return null;
    }
}

function getBrowserLanguage() {
    if (typeof navigator === "undefined") {
        return FALLBACK_LANGUAGE;
    }

    const languages = Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language];

    for (const language of languages) {
        const normalized = normalizeLanguage(language);
        if (SUPPORTED_LANGUAGES.includes(normalized)) {
            return normalized;
        }
    }

    return FALLBACK_LANGUAGE;
}

function resolveLanguage(preferredLanguage = null) {
    if (preferredLanguage !== null && preferredLanguage !== undefined) {
        return normalizeLanguage(preferredLanguage);
    }

    return getStoredLanguage() ?? getBrowserLanguage();
}

export function initI18n(preferredLanguage = null) {
    if (initialized) {
        return i18next;
    }

    i18next.init({
        debug: false,
        fallbackLng: FALLBACK_LANGUAGE,
        initImmediate: false,
        interpolation: {
            escapeValue: false,
        },
        lng: resolveLanguage(preferredLanguage),
        resources: Object.fromEntries(
            Object.entries(TRANSLATION_RESOURCES).map(([language, translation]) => [
                language,
                {translation},
            ])
        ),
        returnEmptyString: false,
        supportedLngs: SUPPORTED_LANGUAGES,
    });

    initialized = true;
    return i18next;
}

function warnMissingKey(key) {
    if (IS_PRODUCTION || warnedMissingKeys.has(key)) {
        return;
    }

    warnedMissingKeys.add(key);
    console.warn(`[i18n] Missing translation key: ${key}`);
}

export function t(key, options = undefined) {
    initI18n();

    // Don't warn when caller passed an explicit defaultValue — that's the
    // i18next-idiomatic way to say "this key may be missing, use this
    // fallback." Dynamic per-node label paths like "nodeLabels.<id>" hit
    // this hundreds of times during sitch reload (one per per-track GUI
    // control) and otherwise drown out the rest of the console.
    if (!i18next.exists(key, options) && (!options || options.defaultValue === undefined)) {
        warnMissingKey(key);
    }

    return i18next.t(key, options);
}

export function getCurrentLanguage() {
    initI18n();
    return i18next.language;
}

export function setLanguage(language) {
    initI18n();

    const normalizedLanguage = normalizeLanguage(language);
    i18next.changeLanguage(normalizedLanguage);

    if (typeof window !== "undefined" && window.localStorage) {
        try {
            window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalizedLanguage);
        } catch (_error) {
        }
    }

    return normalizedLanguage;
}

function getTranslationResourceValue(resource, key) {
    return key.split(".").reduce((value, part) => value?.[part], resource);
}

export function getTranslationVariants(key) {
    const variants = new Set();

    for (const translation of Object.values(TRANSLATION_RESOURCES)) {
        const value = getTranslationResourceValue(translation, key);
        if (typeof value === "string" && value.trim() !== "") {
            variants.add(value);
        }
    }

    return [...variants];
}
