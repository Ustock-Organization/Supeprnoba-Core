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

        let image = null;
        let title = null;
        let followerCount = null;
        let subscriberCount = null;

        // 1. YouTube
        if (platform === 'YOUTUBE' && process.env.YOUTUBE_API_KEY) {
            console.log('[PREVIEW] Fetching YouTube Metadata...');
            try {
                const ytKey = process.env.YOUTUBE_API_KEY;
                let channelId = null;
                let handle = null;

                if (url.includes('@')) {
                    // Support Korean and other unicode characters in handle
                    const match = url.match(/@([^\/\?\s]+)/);
                    if (match) handle = decodeURIComponent(match[1]);
                } else if (url.includes('/channel/')) {
                    const match = url.match(/\/channel\/([a-zA-Z0-9_-]+)/);
                    if (match) channelId = match[1];
                } else if (url.includes('/c/')) {
                    const match = url.match(/\/c\/([a-zA-Z0-9_-]+)/);
                    if (match) {
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

                // Fetch channel with statistics
                const fetchChannelData = async (chId) => {
                    const ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${chId}&key=${ytKey}`;
                    const ytRes = await fetch(ytUrl);
                    const ytData = await ytRes.json();
                    if (ytData.items?.[0]) {
                        const item = ytData.items[0];
                        const snip = item.snippet;
                        image = snip.thumbnails.high?.url || snip.thumbnails.medium?.url || snip.thumbnails.default?.url;
                        title = snip.title;
                        // Get subscriber count
                        if (item.statistics?.subscriberCount) {
                            subscriberCount = parseInt(item.statistics.subscriberCount, 10);
                        }
                    }
                };

                if (channelId) {
                    await fetchChannelData(channelId);
                } else if (handle) {
                    // Check if handle contains non-ASCII (Korean, etc.)
                    const isNonAscii = /[^\x00-\x7F]/.test(handle);
                    
                    if (!isNonAscii) {
                        // Try forHandle with statistics (only for ASCII handles)
                        const forHandleUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent(handle)}&key=${ytKey}`;
                        const forHandleRes = await fetch(forHandleUrl);
                        const forHandleData = await forHandleRes.json();
                        if (forHandleData.items?.[0]) {
                            const item = forHandleData.items[0];
                            const snip = item.snippet;
                            image = snip.thumbnails.high?.url || snip.thumbnails.medium?.url || snip.thumbnails.default?.url;
                            title = snip.title;
                            if (item.statistics?.subscriberCount) {
                                subscriberCount = parseInt(item.statistics.subscriberCount, 10);
                            }
                        }
                    }
                    
                    // Fallback to search API (works for Korean handles)
                    if (!title) {
                        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(handle)}&key=${ytKey}&maxResults=1`;
                        const searchRes = await fetch(searchUrl);
                        const searchData = await searchRes.json();
                        const foundId = searchData.items?.[0]?.id?.channelId;
                        if (foundId) {
                            await fetchChannelData(foundId);
                        }
                    }
                }
            } catch (e) {
                console.error('[PREVIEW] YouTube Error:', e);
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
                    // Request public_metrics for follower count
                    const xRes = await fetch(
                        `https://api.twitter.com/2/users/by/username/${username}?user.fields=profile_image_url,name,public_metrics`,
                        { headers: { 'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}` } }
                    );
                    const xData = await xRes.json();
                    
                    if (xRes.ok && xData.data) {
                        const rawImg = xData.data.profile_image_url;
                        image = rawImg ? rawImg.replace(/_(normal|mini|bigger)\./, '.') : null; 
                        if (image === rawImg && image) image = rawImg.replace('_normal', '_400x400');
                        
                        title = xData.data.name;
                        
                        // Get follower count from public_metrics
                        if (xData.data.public_metrics?.followers_count) {
                            followerCount = xData.data.public_metrics.followers_count;
                        }
                    } else {
                        console.error('[PREVIEW] X API Error:', JSON.stringify(xData));
                    }
                }
            } catch (e) {
                console.error('[PREVIEW] X Error:', e);
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
                // Return both fields for frontend compatibility
                followerCount: followerCount,
                subscriberCount: subscriberCount,
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
