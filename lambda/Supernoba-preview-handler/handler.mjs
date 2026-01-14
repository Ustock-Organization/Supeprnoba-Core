// Supernoba-preview-handler
// Serverless function to preview creator profiles from URLs (YouTube, X, etc.)

export const handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Content-Type': 'application/json',
    };

    if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    const queryParams = event.queryStringParameters || {};
    const url = queryParams.url;

    if (!url) {
        return { 
            statusCode: 400, 
            headers, 
            body: JSON.stringify({ error: 'URL is required' }) 
        };
    }

    console.log(`[PREVIEW] Processing: ${url}`);

    try {
        if (!url.startsWith('http')) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid URL format' }) };
        }

        const platform = detectPlatform(url);
        console.log(`[PREVIEW] Detected Platform: ${platform}`);
        console.log(`[PREVIEW] Detected Platform: ${platform}`);
        console.log(`[DEBUG] Token Present: ${!!process.env.TWITTER_BEARER_TOKEN}`);
        console.log('[DEBUG] VERSION: CHECK_FINAL_TAR');

        let image = null;
        let title = null;
        let errorDetails = null;

        // 1. YouTube
        if (platform === 'YOUTUBE' && process.env.YOUTUBE_API_KEY) {
            console.log('[PREVIEW] Fetching YouTube Metadata...');
            try {
                const ytKey = process.env.YOUTUBE_API_KEY;
                let channelId = null;
                let handle = null;

                if (url.includes('@')) {
                    const match = url.match(/@([\w\-\.]+)/);
                    if (match) handle = match[1];
                } else if (url.includes('/channel/')) {
                    const match = url.match(/\/channel\/([a-zA-Z0-9_-]+)/);
                    if (match) channelId = match[1];
                } else if (url.includes('/c/')) {
                    const match = url.match(/\/c\/([a-zA-Z0-9_-]+)/);
                    if (match) {
                        // Search for channel ID
                        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(match[1])}&key=${ytKey}&maxResults=1`;
                        const searchRes = await fetch(searchUrl);
                        const searchData = await searchRes.json();
                        channelId = searchData.items?.[0]?.id?.channelId || searchData.items?.[0]?.snippet?.channelId;
                    }
                } else if (url.includes('youtu.be/')) {
                    const videoId = url.split('youtu.be/')[1]?.split('?')[0];
                    if (videoId) {
                        const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${ytKey}`;
                        const videoRes = await fetch(videoUrl);
                        const videoData = await videoRes.json();
                        channelId = videoData.items?.[0]?.snippet?.channelId;
                    }
                }

                if (channelId) {
                    const ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${ytKey}`;
                    const ytRes = await fetch(ytUrl);
                    const ytData = await ytRes.json();
                    if (ytData.items?.[0]) {
                        const snip = ytData.items[0].snippet;
                        image = snip.thumbnails.high?.url || snip.thumbnails.medium?.url || snip.thumbnails.default?.url;
                        title = snip.title;
                    }
                } else if (handle) {
                     // Try forHandle
                     const forHandleUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${handle}&key=${ytKey}`;
                     const forHandleRes = await fetch(forHandleUrl);
                     const forHandleData = await forHandleRes.json();
                     if (forHandleData.items?.[0]) {
                         const snip = forHandleData.items[0].snippet;
                         image = snip.thumbnails.high?.url || snip.thumbnails.medium?.url || snip.thumbnails.default?.url;
                         title = snip.title;
                     } else {
                         // Fallback search
                         const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(handle)}&key=${ytKey}&maxResults=1`;
                         const searchRes = await fetch(searchUrl);
                         const searchData = await searchRes.json();
                         const foundId = searchData.items?.[0]?.id?.channelId;
                         if (foundId) {
                             const chRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${foundId}&key=${ytKey}`);
                             const chData = await chRes.json();
                             if (chData.items?.[0]) {
                                 title = chData.items[0].snippet.title;
                                 image = chData.items[0].snippet.thumbnails.high?.url;
                             }
                         }
                     }
                }
            } catch (e) {
                console.error('[PREVIEW] YouTube Error:', e);
                errorDetails = e.message;
            }
        }

        // 2. X (Twitter)
        if (platform === 'X' && process.env.TWITTER_BEARER_TOKEN) {
            console.log('[PREVIEW] Fetching X Metadata...');
            try {
                let username = null;
                const match = url.match(/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)/);
                if (match) username = match[1];
                else {
                    const parts = url.split('/');
                    username = parts[parts.length - 1].split('?')[0];
                }

                if (username && !['i', 'home', 'search'].includes(username)) {
                    const xRes = await fetch(
                        `https://api.twitter.com/2/users/by/username/${username}?user.fields=profile_image_url,name`,
                        { headers: { 'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}` } }
                    );
                    const xData = await xRes.json();
                    
                    if (!xRes.ok) {
                        console.error('[PREVIEW] X API Error:', JSON.stringify(xData));
                        errorDetails = `API Error: ${xRes.status} ${JSON.stringify(xData)}`;
                    } else {
                        // Success case debugging
                        errorDetails = `Success Raw Data: ${JSON.stringify(xData)}`;
                        
                        if (xData.data) {
                            const rawImg = xData.data.profile_image_url;
                            image = rawImg ? rawImg.replace(/_(normal|mini|bigger)\./, '.') : null; 
                            if (image === rawImg && image) image = rawImg.replace('_normal', '_400x400');
                            
                            title = xData.data.name;
                        } else {
                             errorDetails += ' | No Data found for user';
                        }
                    }
                }
            } catch (e) {
                console.error('[PREVIEW] X Error:', e);
                errorDetails = e.message;
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                url,
                title: title || '',
                image: image || '',
                platform,
                debug_error: errorDetails
            })
        };

    } catch (err) {
        console.error('[PREVIEW] Critical Error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: err.message })
        };
    }
};

function detectPlatform(url) {
    if (!url) return 'ETC';
    const lower = url.toLowerCase();
    if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'YOUTUBE';
    if (lower.includes('twitter.com') || lower.includes('x.com')) return 'X';
    if (lower.includes('instagram.com')) return 'INSTAGRAM';
    if (lower.includes('tiktok.com')) return 'TIKTOK';
    if (lower.includes('chzzk')) return 'CHZZK';
    if (lower.includes('afreecatv')) return 'AFREECATV';
    return 'ETC';
}
