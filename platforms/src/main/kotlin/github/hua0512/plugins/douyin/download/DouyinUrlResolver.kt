/*
 * MIT License
 *
 * Stream-rec  https://github.com/hua0512/stream-rec
 *
 * Copyright (c) 2025 hua0512 (https://github.com/hua0512)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

package github.hua0512.plugins.douyin.download

import com.github.michaelbull.result.*
import github.hua0512.plugins.base.ExtractorError
import github.hua0512.plugins.douyin.download.DouyinApis.Companion.APP_ROOM_REFLOW
import github.hua0512.plugins.douyin.download.DouyinApis.Companion.LIVE_DOUYIN_URL
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.serialization.json.*
import java.net.URI

private const val MAX_REDIRECTS = 5
private const val MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36"
private const val PC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
private const val USER_PROFILE_API = "https://www.douyin.com/aweme/v1/web/user/profile/other/"

private val UNIQUE_ID_PATTERNS = listOf(
  """"unique_id"\s*:\s*"([^"]+)"""".toRegex(),
  """unique_id":"([^"]+)","verification_type""".toRegex(),
)

fun isDouyinUrl(url: String): Boolean {
  val parsed = parseUrl(url) ?: return false
  return isDouyinHost(parsed.host)
}

internal suspend fun resolveDouyinExtractUrl(http: HttpClient, url: String): Result<String, ExtractorError> {
  val startUrl = normalizeUrl(url) ?: return Err(ExtractorError.InvalidExtractionUrl)
  val start = parseUrl(startUrl) ?: return Err(ExtractorError.InvalidExtractionUrl)

  if (!isDouyinHost(start.host)) {
    return Err(ExtractorError.InvalidExtractionUrl)
  }

  if (start.host.equals("live.douyin.com", ignoreCase = true)) {
    return Ok(startUrl)
  }

  val redirectedUrlResult = resolveRedirectUrl(http, startUrl)
  if (redirectedUrlResult.isErr) {
    return redirectedUrlResult.asErr()
  }

  val redirectedUrl = redirectedUrlResult.get()!!
  val redirected = parseUrl(redirectedUrl) ?: return Ok(redirectedUrl)

  val liveUrlResult = when {
    redirected.host.equals("live.douyin.com", ignoreCase = true) -> Ok(redirectedUrl)
    isReflowUrl(redirected) -> resolveReflowLiveUrl(http, redirected)
    else -> resolveUserLiveUrl(http, redirected)
  }

  return liveUrlResult
}

private suspend fun resolveRedirectUrl(http: HttpClient, url: String): Result<String, ExtractorError> {
  var currentUrl = url
  repeat(MAX_REDIRECTS) {
    val response = try {
      http.get(currentUrl) {
        headers {
          append(HttpHeaders.Accept, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
          append(HttpHeaders.AcceptLanguage, "zh-CN,zh;q=0.9,en;q=0.8")
          append(HttpHeaders.Referrer, LIVE_DOUYIN_URL)
          append(HttpHeaders.UserAgent, MOBILE_USER_AGENT)
        }
      }
    } catch (e: Exception) {
      return Err(ExtractorError.ApiError(e))
    }

    val effectiveUrl = response.call.request.url.toString()
    val location = response.headers[HttpHeaders.Location]

    if (effectiveUrl != currentUrl) {
      currentUrl = effectiveUrl
    }

    if (location.isNullOrBlank()) {
      return Ok(currentUrl)
    }

    currentUrl = resolveLocation(currentUrl, location)
  }

  return Err(ExtractorError.InvalidResponse("Douyin redirect exceeded $MAX_REDIRECTS hops"))
}

private suspend fun resolveReflowLiveUrl(http: HttpClient, url: Url): Result<String, ExtractorError> {
  val roomId = url.lastPathSegment().takeIf { it.isNotBlank() }
    ?: return Err(ExtractorError.InvalidExtractionUrl)
  val secUid = url.parameters["sec_user_id"].takeIf { !it.isNullOrBlank() }
    ?: return Err(ExtractorError.InvalidExtractionUrl)

  val response = try {
    http.get(APP_ROOM_REFLOW) {
      headers {
        append(HttpHeaders.Accept, "application/json, text/plain, */*")
        append(HttpHeaders.Referrer, LIVE_DOUYIN_URL)
        append(HttpHeaders.UserAgent, MOBILE_USER_AGENT)
      }
      fillDouyinAppCommonParams()
      fillSecUid(secUid)
      parameter(DouyinParams.ROOM_ID_KEY, roomId)
      contentType(ContentType.Application.Json)
    }
  } catch (e: Exception) {
    return Err(ExtractorError.ApiError(e))
  }

  val body = try {
    response.body<JsonElement>()
  } catch (e: Exception) {
    return Err(ExtractorError.InvalidResponse("Failed to parse Douyin reflow response: ${e.message}"))
  }

  val webRid = body.jsonObject["data"]?.jsonObject
    ?.get("room")?.jsonObject
    ?.get("owner")?.jsonObject
    ?.get("web_rid")?.jsonPrimitive
    ?.contentOrNull
    ?.takeIf { it.isNotBlank() }
    ?: return Err(ExtractorError.InvalidResponse("Douyin reflow response missing web_rid"))

  return Ok("$LIVE_DOUYIN_URL/$webRid")
}

private suspend fun resolveUserLiveUrl(http: HttpClient, url: Url): Result<String, ExtractorError> {
  val secUid = url.userSecUid() ?: return Err(ExtractorError.InvalidExtractionUrl)

  val profileResult = resolveUserLiveUrlFromProfileApi(http, secUid)
  if (profileResult.isOk) {
    return profileResult
  }

  return resolveUserLiveUrlFromSharePage(http, secUid)
}

private suspend fun resolveUserLiveUrlFromProfileApi(http: HttpClient, secUid: String): Result<String, ExtractorError> {
  val parameters = ParametersBuilder().apply {
    append("device_platform", "webapp")
    append("aid", DouyinParams.AID_VALUE)
    append("channel", "channel_pc_web")
    append(DouyinParams.SEC_USER_ID_KEY, secUid)
    append("pc_client_type", "1")
    append("version_code", "170400")
    append("version_name", "17.4.0")
    append("cookie_enabled", "true")
    append("screen_width", "1920")
    append("screen_height", "1080")
    append("browser_language", "zh-CN")
    append("browser_platform", "Win32")
    append("browser_name", "Edge")
    append("browser_version", "117.0.2045.47")
    append("browser_online", "true")
    append("engine_name", "Blink")
    append("engine_version", "117.0.0.0")
    append("os_name", "Windows")
    append("os_version", "10")
    append("cpu_core_num", "8")
    append("device_memory", "8")
    append("platform", "PC")
    append("downlink", "10")
    append("effective_type", "4g")
    append("round_trip_time", "100")
  }.build()

  val cookieResult = resolveTtwidCookie(http)
  if (cookieResult.isErr) {
    return cookieResult.asErr()
  }

  val response = try {
    http.get("$USER_PROFILE_API?${parameters.formUrlEncode()}") {
      headers {
        append(HttpHeaders.Accept, "application/json, text/plain, */*")
        append(HttpHeaders.AcceptLanguage, "zh-CN,zh;q=0.9")
        append(HttpHeaders.Referrer, "https://www.douyin.com/friend")
        append(HttpHeaders.UserAgent, PC_USER_AGENT)
        append(HttpHeaders.Cookie, cookieResult.get()!!)
      }
    }
  } catch (e: Exception) {
    return Err(ExtractorError.ApiError(e))
  }

  val body = response.bodyAsText()
  if (body.isBlank()) {
    return Err(ExtractorError.InvalidResponse("Douyin user profile response was empty"))
  }

  val profileJson = try {
    Json.parseToJsonElement(body)
  } catch (e: Exception) {
    return Err(ExtractorError.InvalidResponse("Failed to parse Douyin user profile response: ${e.message}"))
  }

  val user = profileJson.jsonObject["user"]?.jsonObject
    ?: return Err(ExtractorError.InvalidResponse("Douyin user profile response missing user"))

  val uniqueId = user["unique_id"]?.jsonPrimitive?.contentOrNull
    ?.takeIf { it.isNotBlank() && it != "0" }
  val roomId = user["room_id"]?.jsonPrimitive?.longOrNull
    ?.takeIf { it > 0 }
    ?.toString()

  val liveId = uniqueId ?: roomId
    ?: return Err(ExtractorError.InvalidResponse("Douyin user profile response missing unique_id and room_id"))

  return Ok("$LIVE_DOUYIN_URL/$liveId")
}

private suspend fun resolveTtwidCookie(http: HttpClient): Result<String, ExtractorError> {
  val cookies = try {
    populateDouyinCookieMissedParams("", http)
  } catch (e: Exception) {
    return Err(ExtractorError.ApiError(e))
  }

  val ttwid = parseClientCookiesHeader(cookies)[TT_WID_COOKIE]
    ?: return Err(ExtractorError.InvalidResponse("Failed to get Douyin ttwid cookie"))

  return Ok("$TT_WID_COOKIE=$ttwid")
}

private suspend fun resolveUserLiveUrlFromSharePage(http: HttpClient, secUid: String): Result<String, ExtractorError> {
  val response = try {
    http.get("https://www.iesdouyin.com/share/user/$secUid") {
      headers {
        append(HttpHeaders.Accept, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        append(HttpHeaders.AcceptLanguage, "zh-CN,zh;q=0.9,en;q=0.8")
        append(HttpHeaders.Referrer, LIVE_DOUYIN_URL)
        append(HttpHeaders.UserAgent, MOBILE_USER_AGENT)
      }
    }
  } catch (e: Exception) {
    return Err(ExtractorError.ApiError(e))
  }

  val html = response.bodyAsText()
  val uniqueId = UNIQUE_ID_PATTERNS.firstNotNullOfOrNull { pattern ->
    pattern.find(html)?.groupValues?.getOrNull(1)?.takeIf { it.isNotBlank() }
  }
    ?: return Err(ExtractorError.InvalidResponse("Douyin user page missing unique_id"))

  return Ok("$LIVE_DOUYIN_URL/$uniqueId")
}

private fun isReflowUrl(url: Url): Boolean = url.encodedPath.contains("/reflow/")

private fun Url.lastPathSegment(): String = encodedPath.trimEnd('/').substringAfterLast("/")

private fun Url.userSecUid(): String? {
  val segments = encodedPath.trim('/').split('/').filter { it.isNotBlank() }
  val userIndex = segments.indexOf("user")
  return segments.getOrNull(userIndex + 1)?.takeIf { it.isNotBlank() }
}

private fun isDouyinHost(host: String): Boolean {
  val normalizedHost = host.lowercase()
  return normalizedHost == "douyin.com" ||
    normalizedHost.endsWith(".douyin.com") ||
    normalizedHost == "iesdouyin.com" ||
    normalizedHost.endsWith(".iesdouyin.com") ||
    normalizedHost == "webcast.amemv.com"
}

private fun parseUrl(url: String): Url? {
  val normalizedUrl = normalizeUrl(url) ?: return null
  return kotlin.runCatching { Url(normalizedUrl) }.getOrNull()
}

private fun normalizeUrl(url: String): String? {
  val trimmedUrl = url.trim()
  if (trimmedUrl.isBlank()) {
    return null
  }
  return if (trimmedUrl.startsWith("http://", ignoreCase = true) || trimmedUrl.startsWith("https://", ignoreCase = true)) {
    trimmedUrl
  } else {
    "https://$trimmedUrl"
  }
}

private fun resolveLocation(baseUrl: String, location: String): String {
  return kotlin.runCatching {
    URI(baseUrl).resolve(location).toString()
  }.getOrDefault(location)
}
