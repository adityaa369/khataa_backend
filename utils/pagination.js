// utils/pagination.js
const parsePagination = (query, maxLimit = 50) => {
    let page = parseInt(query.page, 10);
    let limit = parseInt(query.limit, 10);

    if (isNaN(page) || page < 1) page = 1;
    if (isNaN(limit) || limit < 1) limit = 10;
    
    // Explicitly clamp the maximum items returned to prevent Memory/CPU exhaustion
    if (limit > maxLimit) limit = maxLimit;

    const skip = (page - 1) * limit;

    return { page, limit, skip };
};

module.exports = { parsePagination };
