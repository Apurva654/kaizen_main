/**
 * This module provides the Go source code for a simple thread‑safe LRU cache.
 * The Go code is returned as a string so it can be written to a .go file
 * or displayed in documentation.
 */

/**
 * Returns the Go implementation of an LRU cache.
 * The cache stores generic values (interface{}) and is safe for concurrent use.
 */
export function getGoLRUCacheCode(): string {
  return `package main

import (
    "container/list"
    "fmt"
    "sync"
)

type entry struct {
    key   string
    value interface{}
}

type LRUCache struct {
    capacity int
    mu       sync.Mutex
    cache    map[string]*list.Element
    list     *list.List
}

// NewLRUCache creates a new LRU cache with the given capacity.
func NewLRUCache(capacity int) *LRUCache {
    return &LRUCache{
        capacity: capacity,
        cache:    make(map[string]*list.Element),
        list:     list.New(),
    }
}

// Get retrieves a value by key. It returns the value and a bool indicating
// whether the key was found. Access moves the entry to the front (most recent).
func (c *LRUCache) Get(key string) (interface{}, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()
    if elem, ok := c.cache[key]; ok {
        c.list.MoveToFront(elem)
        return elem.Value.(*entry).value, true
    }
    return nil, false
}

// Set inserts or updates a key/value pair. If the cache exceeds its capacity,
// the least‑recently used entry is evicted.
func (c *LRUCache) Set(key string, value interface{}) {
    c.mu.Lock()
    defer c.mu.Unlock()
    if elem, ok := c.cache[key]; ok {
        c.list.MoveToFront(elem)
        elem.Value.(*entry).value = value
        return
    }
    if c.list.Len() >= c.capacity {
        // Evict the least recently used item.
        back := c.list.Back()
        if back != nil {
            evict := back.Value.(*entry)
            delete(c.cache, evict.key)
            c.list.Remove(back)
        }
    }
    e := &entry{key: key, value: value}
    elem := c.list.PushFront(e)
    c.cache[key] = elem
}

// Invalidate removes a specific key from the cache, if present.
func (c *LRUCache) Invalidate(key string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    if elem, ok := c.cache[key]; ok {
        delete(c.cache, key)
        c.list.Remove(elem)
    }
}

func main() {
    // Example usage of the LRU cache.
    cache := NewLRUCache(2)
    cache.Set("a", 1)
    cache.Set("b", 2)
    if v, ok := cache.Get("a"); ok {
        fmt.Println("Got", v) // Should print: Got 1
    }
    // Adding a third entry evicts the least‑recently used key "b".
    cache.Set("c", 3)
    if _, ok := cache.Get("b"); !ok {
        fmt.Println("b was evicted")
    }
}
`;
}

// Export the code string directly for convenience.
export const goLRUCacheCode = getGoLRUCacheCode();