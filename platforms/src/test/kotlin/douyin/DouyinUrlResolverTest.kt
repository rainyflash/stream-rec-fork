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

package douyin

import github.hua0512.plugins.douyin.download.isDouyinUrl
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.equals.shouldBeEqual

class DouyinUrlResolverTest : FunSpec({

  test("matches douyin live and share urls") {
    listOf(
      "https://live.douyin.com/802975310822",
      "https://v.douyin.com/abc123/",
      "https://www.douyin.com/user/MS4wLjABAAAA_test",
      "https://www.iesdouyin.com/share/user/MS4wLjABAAAA_test",
      "live.douyin.com/802975310822",
    ).forEach { url ->
      isDouyinUrl(url) shouldBeEqual true
    }
  }

  test("rejects non-douyin urls") {
    listOf(
      "",
      "https://www.douyu.com/123",
      "https://example.com/live.douyin.com/123",
    ).forEach { url ->
      isDouyinUrl(url) shouldBeEqual false
    }
  }
})
