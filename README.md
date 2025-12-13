# API Contract (v1) - Social App

Base URL: /api/v1
Content-Type: application/json

Auth:
- Authorization: Bearer <accessToken>
- All "Auth required" endpoints must include the header above.

Time format:
- ISO 8601 string (server returns datetime2(0) as seconds precision)

Unified Error Format:
{
  "error": {
    "code": "VALIDATION_ERROR|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|CONFLICT|INTERNAL_ERROR",
    "message": "Human readable",
    "details": [
      { "field": "email", "reason": "invalid_format" }
    ]
  }
}

Pagination:
Request: page (default 1), pageSize (default 20, max 100)
Response:
{
  "items": [...],
  "page": 1,
  "pageSize": 20,
  "total": 123
}

---

## Data Models

### User (from users)
{
  "userId": 1,
  "email": "a@b.com",
  "userName": "Kevin",
  "bio": "hello",
  "profilePic": "https://...",
  "createdAt": "2025-12-13T19:00:00+08:00"
}

Notes:
- API never returns password field.

### Post (from post + users)
{
  "postId": 10,
  "author": {
    "userId": 1,
    "userName": "Kevin",
    "profilePic": "https://..."
  },
  "picture": "https://...",
  "content": "text...",
  "likes": 3,
  "createdAt": "2025-12-13T19:00:00+08:00",
  "likedByMe": false
}

### Comment (from comment + users)
{
  "commentId": 99,
  "postId": 10,
  "author": {
    "userId": 2,
    "userName": "Amy",
    "profilePic": "https://..."
  },
  "content": "nice!", 
  "createdAt": "2025-12-13T19:00:00+08:00"
}

Note:
- In DB it is comment.context; API uses content for clarity.

---

# Endpoints

## Auth

### POST /auth/register
Request:
{
  "email": "a@b.com",
  "password": "12345678",
  "userName": "Kevin"
}
Response 201:
{
  "accessToken": "<jwt>",
  "user": { ...User }
}
Errors:
- 409 CONFLICT (email already used)

### POST /auth/login
Request:
{
  "email": "a@b.com",
  "password": "12345678"
}
Response 200:
{
  "accessToken": "<jwt>",
  "user": { ...User }
}
Errors:
- 401 UNAUTHORIZED

---

## Users

### GET /users/me
Auth required
Response 200:
{ ...User }

### PATCH /users/me
Auth required
Request (all optional):
{
  "userName": "NewName",
  "bio": "new bio",
  "profilePic": "https://..."
}
Response 200:
{ ...User }

### GET /users/{userId}
Response 200:
{ ...User }
Errors:
- 404 NOT_FOUND

---

## Posts

### POST /posts
Auth required
Request:
{
  "picture": "https://...",
  "content": "Hello world"
}
Response 201:
{ ...Post }

### GET /posts/{postId}
Response 200:
{ ...Post }
Errors:
- 404 NOT_FOUND

### GET /posts?page=1&pageSize=20
Response 200:
{
  "items": [{ ...Post }],
  "page": 1,
  "pageSize": 20,
  "total": 123
}

### DELETE /posts/{postId}
Auth required (must be author)
Response 204

---

## Likes

### POST /posts/{postId}/like
Auth required
Behavior:
- Insert into likes(post_id, user_id)
- Increment post.likes
Response 200:
{ "liked": true, "likes": 4 }
Errors:
- 409 CONFLICT (already liked) [optional: you can also make it idempotent and still return liked=true]

### DELETE /posts/{postId}/like
Auth required
Behavior:
- Delete from likes(post_id, user_id)
- Decrement post.likes
Response 200:
{ "liked": false, "likes": 3 }

---

## Comments

### POST /posts/{postId}/comments
Auth required
Request:
{ "content": "nice!" }
Response 201:
{ ...Comment }

### GET /posts/{postId}/comments?page=1&pageSize=20
Response 200:
{
  "items": [{ ...Comment }],
  "page": 1,
  "pageSize": 20,
  "total": 10
}

### DELETE /comments/{commentId}
Auth required (must be author)
Response 204

---

## Follows

### POST /users/{userId}/follow
Auth required
Behavior:
- Insert into follow(follower_id = me, followee_id = userId)
Response 200:
{ "following": true }
Errors:
- 409 CONFLICT (already following)
- 400 VALIDATION_ERROR (cannot follow self)

### DELETE /users/{userId}/follow
Auth required
Response 200:
{ "following": false }

### GET /users/{userId}/followers?page=1&pageSize=20
Response 200: pagination(User)

### GET /users/{userId}/following?page=1&pageSize=20
Response 200: pagination(User)
