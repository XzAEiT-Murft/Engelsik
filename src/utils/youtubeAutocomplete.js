const ytSearch = require('yt-search');

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;
const autocompleteCache = new Map();

function normalizeQuery(query) {
    return query.trim().replace(/\s+/g, ' ');
}

function isDirectUrl(query) {
    try {
        new URL(query.trim().replace(/^<(.+)>$/, '$1'));
        return true;
    } catch {
        return false;
    }
}

function formatDuration(seconds, fallback = '?:??') {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return fallback;
    }

    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainingSeconds = total % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(
            remainingSeconds
        ).padStart(2, '0')}`;
    }

    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function truncateChoiceName(text, maxLength = 100) {
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
}

function getCachedResults(cacheKey) {
    const cached = autocompleteCache.get(cacheKey);

    if (!cached) {
        return null;
    }

    if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
        autocompleteCache.delete(cacheKey);
        return null;
    }

    return cached.results;
}

function getPrefixCachedResults(cacheKey) {
    const cachedKeys = [...autocompleteCache.keys()].sort(
        (left, right) => right.length - left.length
    );

    for (const key of cachedKeys) {
        if (!cacheKey.startsWith(key)) {
            continue;
        }

        const cachedResults = getCachedResults(key);

        if (!cachedResults?.length) {
            continue;
        }

        const terms = cacheKey.split(' ').filter(Boolean);
        const filteredResults = cachedResults.filter(result => {
            const haystack = result.name.toLowerCase();
            return terms.every(term => haystack.includes(term));
        });

        if (filteredResults.length) {
            return filteredResults;
        }
    }

    return null;
}

function setCachedResults(cacheKey, results) {
    if (autocompleteCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = autocompleteCache.keys().next().value;

        if (oldestKey) {
            autocompleteCache.delete(oldestKey);
        }
    }

    autocompleteCache.set(cacheKey, {
        createdAt: Date.now(),
        results
    });
}

async function searchAutocompleteSuggestions(query, limit = 12) {
    const normalizedQuery = normalizeQuery(query);

    if (
        !normalizedQuery ||
        normalizedQuery.length < 3 ||
        isDirectUrl(normalizedQuery)
    ) {
        return [];
    }

    const cacheKey = normalizedQuery.toLowerCase();
    const cachedResults = getCachedResults(cacheKey);

    if (cachedResults) {
        return cachedResults.slice(0, limit);
    }

    const prefixCachedResults = getPrefixCachedResults(cacheKey);

    if (prefixCachedResults) {
        return prefixCachedResults.slice(0, limit);
    }

    const response = await ytSearch(normalizedQuery);
    const results = response.videos.slice(0, Math.min(limit, 15)).map(video => {
        const durationLabel =
            video.timestamp || formatDuration(video.seconds, 'LIVE');
        const label = truncateChoiceName(
            `${video.title} (${durationLabel})`
        );

        return {
            name: label,
            value: video.url
        };
    });

    setCachedResults(cacheKey, results);
    return results.slice(0, limit);
}

module.exports = {
    searchAutocompleteSuggestions
};
