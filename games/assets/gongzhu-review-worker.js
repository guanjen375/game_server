importScripts('gongzhu-ai.js', 'gongzhu-review.js');

const control = { signal: new AbortController().signal, priority: -1 };
self.onmessage = async ({ data }) => {
    control.priority = data.priority;
    if (!data.record) return;
    try {
        const review = new GongZhuReview(data.record);
        await review.run(data.rows, (i, mode, value) => self.postMessage({ i, mode, value }), control);
        self.postMessage({ done: true });
    } catch (error) {
        self.postMessage({ error: error.message });
    }
};
