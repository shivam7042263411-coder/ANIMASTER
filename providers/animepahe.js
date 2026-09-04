/*
 * AnimePahe provider for Nuvio.
 *
 * This provider intentionally makes direct requests only. AnimePahe may put
 * Cloudflare/robot checks in front of its pages; those responses are detected
 * and reported as an unavailable source instead of being bypassed.
 *
 * Nuvio calls:
 *   getStreams(tmdbId, mediaType, season, episode)
 */

var DEFAULT_DOMAIN = "https://animepahe.com";
var USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function getSettings() {
  if (typeof globalThis !== "undefined" && globalThis.SCRAPER_SETTINGS) {
    return globalThis.SCRAPER_SETTINGS;
  }
  return {};
}

function getDomain() {
  var configured = getSettings().domain;
  if (typeof configured !== "string" || configured.trim() === "") {
    return DEFAULT_DOMAIN;
  }
  return configured.replace(/\/+$/, "");
}

function absoluteUrl(url, base) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, base).toString();
  } catch (error) {
    return "";
  }
}

function mergeHeaders(extra) {
  var headers = {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": USER_AGENT
  };
  if (extra) {
    Object.keys(extra).forEach(function (key) {
      headers[key] = extra[key];
    });
  }
  return headers;
}

function isRobotChallenge(response, body) {
  var mitigated = "";
  try {
    mitigated = response.headers.get("cf-mitigated") || "";
  } catch (error) {
    mitigated = "";
  }

  if (mitigated.toLowerCase() === "challenge") return true;

  var text = String(body || "").toLowerCase();
  return (
    text.indexOf("just a moment") !== -1 ||
    text.indexOf("verify you are human") !== -1 ||
    text.indexOf("performing security verification") !== -1 ||
    text.indexOf("challenge-platform") !== -1 ||
    text.indexOf("challenges.cloudflare.com") !== -1 ||
    text.indexOf("cf-chl-") !== -1
  );
}

function request(url, options) {
  var requestOptions = options || {};
  var headers = mergeHeaders(requestOptions.headers);
  var fetchOptions = {};
  Object.keys(requestOptions).forEach(function (key) {
    if (key !== "headers") fetchOptions[key] = requestOptions[key];
  });
  fetchOptions.headers = headers;

  return fetch(url, fetchOptions).then(function (response) {
    return response.text().then(function (body) {
      if (isRobotChallenge(response, body)) {
        throw new Error(
          "AnimePahe returned a robot/security verification challenge"
        );
      }
      if (!response.ok) {
        throw new Error("AnimePahe returned HTTP " + response.status);
      }
      return { response: response, body: body };
    });
  });
}

function requestJson(url) {
  return request(url, {
    headers: { Accept: "application/json, text/plain, */*" }
  }).then(function (result) {
    try {
      return JSON.parse(result.body);
    } catch (error) {
      throw new Error("AnimePahe returned an invalid JSON response");
    }
  });
}

function normalise(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  var output = [];
  var seen = {};
  (values || []).forEach(function (value) {
    if (typeof value !== "string" || value.trim() === "") return;
    var key = normalise(value);
    if (!key || seen[key]) return;
    seen[key] = true;
    output.push(value.trim());
  });
  return output;
}

function getMetadata(tmdbId, mediaType) {
  var kind = mediaType === "movie" ? "movie" : "tv";
  var url =
    "https://v3-cinemeta.strem.io/meta/" +
    kind +
    "/" +
    encodeURIComponent(String(tmdbId)) +
    ".json";

  return requestJson(url).then(function (data) {
    return data && data.meta ? data.meta : {};
  });
}

function getTitleCandidates(metadata) {
  var aliases = metadata && metadata.aliases;
  if (!Array.isArray(aliases)) aliases = [];
  return uniqueStrings(
    [
      metadata && metadata.name,
      metadata && metadata.originalName,
      metadata && metadata.original_name,
      metadata && metadata.english_name
    ].concat(aliases)
  );
}

function searchAnime(domain, title) {
  var url =
    domain +
    "/api?m=search&l=8&q=" +
    encodeURIComponent(title);
  return requestJson(url);
}

function scoreSearchResult(result, requestedTitle, year) {
  var wanted = normalise(requestedTitle);
  var actual = normalise(result && (result.title || result.name));
  if (!wanted || !actual) return -1;

  var score = 0;
  if (actual === wanted) score += 100;
  else if (actual.indexOf(wanted) === 0) score += 75;
  else if (actual.indexOf(wanted) !== -1 || wanted.indexOf(actual) !== -1) {
    score += 50;
  }

  if (year && result && String(result.year || "") === String(year)) {
    score += 10;
  }
  return score;
}

function findAnimeSession(domain, titles, year, index, best) {
  if (index >= titles.length || index >= 3) {
    return Promise.resolve(best && best.session ? best : null);
  }

  return searchAnime(domain, titles[index]).then(function (payload) {
    var results = payload && Array.isArray(payload.data) ? payload.data : [];
    var current = best;
    results.forEach(function (result) {
      var score = scoreSearchResult(result, titles[index], year);
      if (score >= 0 && (!current || score > current._score)) {
        current = {
          session: result.session,
          title: result.title || result.name || titles[index],
          _score: score
        };
      }
    });

    if (current && current._score >= 100) {
      return current;
    }
    return findAnimeSession(domain, titles, year, index + 1, current);
  });
}

function getEpisodeNumber(metadata, season, episode) {
  var targetSeason = Number(season);
  var targetEpisode = Number(episode);
  if (!isFinite(targetEpisode) || targetEpisode < 1) return 1;
  if (!isFinite(targetSeason) || targetSeason <= 1) return targetEpisode;

  /*
   * AnimePahe generally numbers a multi-season title continuously. Cinemeta
   * supplies the season/episode list, so use it when available. If metadata
   * is incomplete, keep the Nuvio episode number as a safe fallback.
   */
  var videos = metadata && Array.isArray(metadata.videos) ? metadata.videos : [];
  var count = 0;
  videos.forEach(function (video) {
    var videoSeason = Number(video && video.season);
    var videoEpisode = Number(video && video.episode);
    if (
      isFinite(videoSeason) &&
      isFinite(videoEpisode) &&
      videoSeason >= 1 &&
      videoEpisode >= 1 &&
      (videoSeason < targetSeason ||
        (videoSeason === targetSeason && videoEpisode <= targetEpisode))
    ) {
      count += 1;
    }
  });
  return count > 0 ? count : targetEpisode;
}

function getEpisodeSession(domain, animeSession, episodeNumber) {
  var firstUrl =
    domain +
    "/api?m=release&id=" +
    encodeURIComponent(animeSession) +
    "&sort=episode_asc&page=1";

  return requestJson(firstUrl).then(function (firstPage) {
    var firstData =
      firstPage && Array.isArray(firstPage.data) ? firstPage.data : [];
    if (!firstData.length) return null;

    var firstEpisode = Math.floor(Number(firstData[0].episode));
    if (!isFinite(firstEpisode)) firstEpisode = 1;
    var perPage = Number(firstPage.per_page) || 30;
    var targetEpisode = firstEpisode - 1 + episodeNumber;
    var page = Math.max(
      1,
      Math.ceil((targetEpisode - firstEpisode + 1) / perPage)
    );
    var targetUrl =
      domain +
      "/api?m=release&id=" +
      encodeURIComponent(animeSession) +
      "&sort=episode_asc&page=" +
      page;

    return requestJson(targetUrl).then(function (targetPage) {
      var targetData =
        targetPage && Array.isArray(targetPage.data) ? targetPage.data : [];
      var all = targetData.concat(page === 1 ? [] : firstData);
      for (var index = 0; index < all.length; index += 1) {
        if (Math.floor(Number(all[index].episode)) === targetEpisode) {
          return all[index].session || null;
        }
      }
      return null;
    });
  });
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function extractAttributeTags(html, tagName, attributeName) {
  var expression = new RegExp(
    "<" +
      tagName +
      "\\b[^>]*\\b" +
      attributeName +
      "\\s*=\\s*(['\"])([\\s\\S]*?)\\1[^>]*>([\\s\\S]*?)<\\/" +
      tagName +
      ">",
    "gi"
  );
  var matches = [];
  var match;
  while ((match = expression.exec(html))) {
    matches.push({
      url: decodeHtmlEntities(match[2]),
      label: String(match[3] || "").replace(/<[^>]+>/g, " ").trim()
    });
  }
  return matches;
}

function extractQuality(label) {
  var match = String(label || "").match(/(\d{3,4}p)/i);
  return match ? match[1].toLowerCase() : "unknown";
}

function isDirectMediaUrl(url) {
  return /\.(m3u8|mp4)(?:[?#]|$)/i.test(url || "");
}

function extractDirectMediaUrl(html) {
  var patterns = [
    /(?:file|source|src)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)/i,
    /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i
  ];
  for (var index = 0; index < patterns.length; index += 1) {
    var match = String(html || "").match(patterns[index]);
    if (match && match[1]) return decodeHtmlEntities(match[1]);
  }
  return "";
}

function resolveMediaLink(url, domain) {
  var directUrl = absoluteUrl(url, domain);
  if (!directUrl) return Promise.resolve(null);
  if (isDirectMediaUrl(directUrl)) {
    return Promise.resolve({
      url: directUrl,
      headers: { Referer: domain + "/", "User-Agent": USER_AGENT }
    });
  }

  return request(directUrl, {
    headers: { Referer: domain + "/" }
  })
    .then(function (result) {
      var extracted = extractDirectMediaUrl(result.body);
      if (!extracted) return null;
      return {
        url: extracted,
        headers: {
          Referer: directUrl,
          "User-Agent": USER_AGENT
        }
      };
    })
    .catch(function () {
      return null;
    });
}

function uniqueStreams(streams) {
  var seen = {};
  return streams.filter(function (stream) {
    if (!stream || !stream.url || seen[stream.url]) return false;
    seen[stream.url] = true;
    return true;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  var domain = getDomain();
  var episodeNumber = Number(episode);

  return getMetadata(tmdbId, mediaType)
    .then(function (metadata) {
      var titles = getTitleCandidates(metadata);
      if (!titles.length) return null;
      return findAnimeSession(domain, titles, metadata.year, 0, null).then(
        function (anime) {
          if (!anime) return null;
          return {
            metadata: metadata,
            anime: anime,
            episodeNumber: getEpisodeNumber(metadata, season, episode)
          };
        }
      );
    })
    .then(function (context) {
      if (!context) return [];
      return getEpisodeSession(
        domain,
        context.anime.session,
        context.episodeNumber
      ).then(function (episodeSession) {
        if (!episodeSession) return [];
        var playUrl =
          domain +
          "/play/" +
          encodeURIComponent(context.anime.session) +
          "/" +
          encodeURIComponent(episodeSession);

        return request(playUrl).then(function (result) {
          var buttons = extractAttributeTags(
            result.body,
            "button",
            "data-src"
          );
          var downloads = extractAttributeTags(
            result.body,
            "a",
            "href"
          ).filter(function (link) {
            return /(?:kwik|pahe\.)/i.test(link.url);
          });
          var links = buttons.concat(downloads);

          return Promise.all(
            links.map(function (link) {
              return resolveMediaLink(link.url, domain).then(function (media) {
                if (!media) return null;
                return {
                  name: "AnimePahe",
                  title:
                    (context.anime.title || "AnimePahe") +
                    " - Episode " +
                    (isFinite(episodeNumber) ? episodeNumber : 1),
                  url: media.url,
                  quality: extractQuality(link.label),
                  headers: media.headers
                };
              });
            })
          ).then(function (streams) {
            return uniqueStreams(
              streams.filter(function (stream) {
                return !!stream;
              })
            );
          });
        });
      });
    })
    .catch(function (error) {
      if (
        error &&
        String(error.message || "").indexOf("robot/security verification") !==
          -1
      ) {
        console.error(
          "[AnimePahe] Source is blocked by a robot/security verification. " +
            "Complete the check in a normal browser or choose another domain."
        );
      } else {
        console.error(
          "[AnimePahe] " + (error && error.message ? error.message : error)
        );
      }
      return [];
    });
}

function onSettings() {
  return Promise.resolve([
    {
      type: "header",
      label: "AnimePahe source"
    },
    {
      type: "info",
      label:
        "AnimePahe may require a browser security check. This provider does not bypass that check."
    },
    {
      type: "select",
      key: "domain",
      label: "Preferred domain",
      description:
        "AnimePahe domains change often. Pick a domain that opens normally in your browser.",
      options: [
        { label: "animepahe.com", value: "https://animepahe.com" },
        { label: "animepahe.org", value: "https://animepahe.org" },
        { label: "animepahe.pw", value: "https://animepahe.pw" }
      ],
      defaultValue: DEFAULT_DOMAIN
    }
  ]);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams, onSettings: onSettings };
} else if (typeof globalThis !== "undefined") {
  globalThis.getStreams = getStreams;
  globalThis.onSettings = onSettings;
}