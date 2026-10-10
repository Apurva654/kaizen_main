import pygame
import random
import sys
import math

pygame.init()

SCREEN_WIDTH = 800
SCREEN_HEIGHT = 600
screen = pygame.display.set_mode((SCREEN_WIDTH, SCREEN_HEIGHT))
pygame.display.set_caption("Star Catcher")

# Colors
DARK_BLUE = (10, 10, 35)
WHITE = (255, 255, 255)
YELLOW = (255, 215, 0)
CYAN = (0, 255, 255)
RED = (220, 20, 60)
ORANGE = (255, 140, 0)
BLUE = (50, 150, 255)
PURPLE = (180, 50, 255)
SHIELD_COLOR = (0, 200, 255)

clock = pygame.time.Clock()

# Game States
STATE_START = 0
STATE_PLAYING = 1
STATE_GAMEOVER = 2
game_state = STATE_START

# Game Variables
score = 0
best_score = 0
lives = 3
level = 1
spawn_timer = 0
spawn_interval = 45  # frames

# Basket properties
basket_width = 110
basket_height = 35
basket_x = SCREEN_WIDTH // 2 - basket_width // 2
basket_y = SCREEN_HEIGHT - 70
basket_speed = 9

# Shield Power-up properties
shield_active = False
shield_timer = 0.0
SHIELD_DURATION = 5.0  # seconds

# Entities list for falling objects: dicts with x, y, type, speed, radius, active
falling_objects = []

# Particle system: list of dicts with x, y, vx, vy, color, life, max_life
particles = []

# Background starfield setup
back_stars = []
for _ in range(70):
    back_stars.append({
        "x": random.randint(0, SCREEN_WIDTH),
        "y": random.randint(0, SCREEN_HEIGHT),
        "speed": random.uniform(0.2, 0.8),
        "size": random.choice([1, 2, 2, 3]),
        "brightness": random.randint(100, 255),
        "twinkle_speed": random.uniform(0.02, 0.08),
        "twinkle_offset": random.uniform(0, math.pi * 2)
    })

font = pygame.font.SysFont(None, 36)
large_font = pygame.font.SysFont(None, 64)
small_font = pygame.font.SysFont(None, 24)

def reset_game():
    global score, lives, level, game_state, basket_x, falling_objects, particles, spawn_timer, spawn_interval, shield_active, shield_timer
    score = 0
    lives = 3
    level = 1
    spawn_timer = 0
    spawn_interval = 45
    game_state = STATE_PLAYING
    basket_x = SCREEN_WIDTH // 2 - basket_width // 2
    falling_objects.clear()
    particles.clear()
    shield_active = False
    shield_timer = 0.0

def spawn_object():
    rand_val = random.random()
    if rand_val < 0.70:
        obj_type = "normal"
        color = YELLOW
        radius = 14
        speed = random.uniform(3.5, 5.0) + (level * 0.4)
    elif rand_val < 0.85:
        obj_type = "bonus"
        color = CYAN
        radius = 12
        speed = random.uniform(4.5, 6.5) + (level * 0.5)
    elif rand_val < 0.95:
        obj_type = "bomb"
        color = RED
        radius = 15
        speed = random.uniform(4.0, 5.5) + (level * 0.3)
    else:
        obj_type = "shield"
        color = PURPLE
        radius = 16
        speed = random.uniform(3.0, 4.5) + (level * 0.2)

    speed = min(speed, 12.0)

    x = random.randint(radius + 20, SCREEN_WIDTH - radius - 20)
    y = -30
    falling_objects.append({
        "x": x,
        "y": y,
        "type": obj_type,
        "color": color,
        "radius": radius,
        "speed": speed,
        "active": True
    })

def add_particles(x, y, color, count=12):
    for _ in range(count):
        angle = random.uniform(0, math.pi * 2)
        speed = random.uniform(1.5, 5.0)
        particles.append({
            "x": x,
            "y": y,
            "vx": math.cos(angle) * speed,
            "vy": math.sin(angle) * speed,
            "color": color,
            "life": 1.0,
            "decay": random.uniform(0.03, 0.07)
        })

running = True
dt = 0.0

while running:
    dt = clock.tick(60) / 1000.0
    screen.fill(DARK_BLUE)

    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
        elif event.type == pygame.KEYDOWN:
            if game_state == STATE_START:
                if event.key == pygame.K_SPACE:
                    reset_game()
            elif game_state == STATE_GAMEOVER:
                if event.key == pygame.K_r or event.key == pygame.K_SPACE:
                    reset_game()

    time_ticks = pygame.time.get_ticks() * 0.001
    for star in back_stars:
        star["y"] += star["speed"]
        if star["y"] > SCREEN_HEIGHT:
            star["y"] = 0
            star["x"] = random.randint(0, SCREEN_WIDTH)
        
        twinkle = math.sin(time_ticks * star["twinkle_speed"] * 20 + star["twinkle_offset"])
        brightness = int(max(50, min(255, star["brightness"] + twinkle * 80)))
        star_color = (brightness, brightness, brightness)
        pygame.draw.circle(screen, star_color, (int(star["x"]), int(star["y"])), star["size"])

    if game_state == STATE_PLAYING:
        if shield_active:
            shield_timer -= dt
            if shield_timer <= 0:
                shield_active = False
                shield_timer = 0.0

        keys = pygame.key.get_pressed()
        if keys[pygame.K_LEFT] or keys[pygame.K_a]:
            basket_x -= basket_speed
            if basket_x < 0:
                basket_x = 0
        if keys[pygame.K_RIGHT] or keys[pygame.K_d]:
            basket_x += basket_speed
            if basket_x > SCREEN_WIDTH - basket_width:
                basket_x = SCREEN_WIDTH - basket_width

        level = 1 + score // 100
        spawn_interval = max(18, 45 - (level * 4))

        spawn_timer += 1
        if spawn_timer >= spawn_interval:
            spawn_timer = 0
            spawn_object()

        basket_rect = pygame.Rect(basket_x, basket_y, basket_width, basket_height)

        for obj in falling_objects:
            if not obj["active"]:
                continue
            
            obj["y"] += obj["speed"]

            obj_rect = pygame.Rect(obj["x"] - obj["radius"], obj["y"] - obj["radius"], obj["radius"] * 2, obj["radius"] * 2)

            if basket_rect.colliderect(obj_rect):
                obj["active"] = False
                if obj["type"] == "normal":
                    score += 10
                    add_particles(obj["x"], obj["y"], YELLOW, 10)
                elif obj["type"] == "bonus":
                    score += 30
                    add_particles(obj["x"], obj["y"], CYAN, 18)
                elif obj["type"] == "bomb":
                    if shield_active:
                        shield_active = False
                        shield_timer = 0.0
                        add_particles(obj["x"], obj["y"], SHIELD_COLOR, 15)
                    else:
                        lives -= 1
                        add_particles(obj["x"], obj["y"], RED, 20)
                        if lives <= 0:
                            game_state = STATE_GAMEOVER
                            if score > best_score:
                                best_score = score
                elif obj["type"] == "shield":
                    shield_active = True
                    shield_timer = SHIELD_DURATION
                    add_particles(obj["x"], obj["y"], PURPLE, 20)

            elif obj["y"] > SCREEN_HEIGHT + obj["radius"]:
                obj["active"] = False
                if obj["type"] == "normal" or obj["type"] == "bonus":
                    lives -= 1
                    if lives <= 0:
                        game_state = STATE_GAMEOVER
                        if score > best_score:
                            best_score = score

        falling_objects = [o for o in falling_objects if o["active"]]

    for p in particles:
        p["x"] += p["vx"]
        p["y"] += p["vy"]
        p["life"] -= p["decay"]
    particles = [p for p in particles if p["life"] > 0]

    for p in particles:
        pygame.draw.circle(screen, p["color"], (int(p["x"]), int(p["y"])), max(1, int(p["life"] * 4)))

    for obj in falling_objects:
        x = int(obj["x"])
        y = int(obj["y"])
        r = obj["radius"]
        o_type = obj["type"]

        if o_type == "normal":
            pygame.draw.circle(screen, YELLOW, (x, y), r)
            pygame.draw.circle(screen, WHITE, (x - 3, y - 3), r // 3)
        elif o_type == "bonus":
            pygame.draw.circle(screen, CYAN, (x, y), r)
            pygame.draw.circle(screen, WHITE, (x, y), r // 2)
        elif o_type == "bomb":
            pygame.draw.circle(screen, (50, 50, 50), (x, y), r)
            pygame.draw.circle(screen, RED, (x, y), r - 3)
            pygame.draw.circle(screen, WHITE, (x - 4, y - 4), 3)
        elif o_type == "shield":
            pygame.draw.circle(screen, PURPLE, (x, y), r)
            pygame.draw.circle(screen, SHIELD_COLOR, (x, y), r - 3, 2)

    base_basket_color = (139, 69, 19)
    rim_color = (205, 133, 63)
    highlight_color = (222, 184, 135)

    pygame.draw.rect(screen, base_basket_color, (basket_x, basket_y, basket_width, basket_height), border_radius=6)
    pygame.draw.rect(screen, highlight_color, (basket_x + 4, basket_y + 4, basket_width - 8, 6), border_radius=3)
    pygame.draw.rect(screen, rim_color, (basket_x - 6, basket_y, basket_width + 12, 9), border_radius=4)

    if shield_active:
        shield_surface = pygame.Surface((basket_width + 30, basket_height + 30), pygame.SRCALPHA)
        pygame.draw.ellipse(shield_surface, (0, 200, 255, 90), (0, 0, basket_width + 30, basket_height + 30), 3)
        screen.blit(shield_surface, (basket_x - 15, basket_y - 10))

    score_text = font.render(f"Score: {score}", True, WHITE)
    level_text = font.render(f"Level: {level}", True, CYAN)
    lives_text = font.render(f"Lives: {max(0, lives)}", True, RED)
    screen.blit(score_text, (20, 20))
    screen.blit(level_text, (20, 55))
    screen.blit(lives_text, (SCREEN_WIDTH - 130, 20))

    if shield_active:
        shield_text = small_font.render(f"SHIELD: {shield_timer:.1f}s", True, SHIELD_COLOR)
        screen.blit(shield_text, (SCREEN_WIDTH - 150, 55))

    if game_state == STATE_START:
        overlay = pygame.Surface((SCREEN_WIDTH, SCREEN_HEIGHT), pygame.SRCALPHA)
        overlay.fill((5, 5, 20, 220))
        screen.blit(overlay, (0, 0))

        title_surf = large_font.render("STAR CATCHER", True, YELLOW)
        subtitle_surf = font.render("Press SPACE to Start", True, CYAN)
        best_surf = font.render(f"Best Score: {best_score}", True, WHITE)
        
        inst_norm = small_font.render("Yellow Star: +10 pts", True, YELLOW)
        inst_bonus = small_font.render("Cyan Star: +30 pts", True, CYAN)
        inst_bomb = small_font.render("Red Bomb: -1 Life (Avoid!)", True, RED)
        inst_shield = small_font.render("Purple Shield: Invulnerability", True, PURPLE)

        screen.blit(title_surf, (SCREEN_WIDTH // 2 - title_surf.get_width() // 2, SCREEN_HEIGHT // 2 - 140))
        screen.blit(subtitle_surf, (SCREEN_WIDTH // 2 - subtitle_surf.get_width() // 2, SCREEN_HEIGHT // 2 - 70))
        screen.blit(best_surf, (SCREEN_WIDTH // 2 - best_surf.get_width() // 2, SCREEN_HEIGHT // 2 - 25))

        screen.blit(inst_norm, (SCREEN_WIDTH // 2 - inst_norm.get_width() // 2, SCREEN_HEIGHT // 2 + 35))
        screen.blit(inst_bonus, (SCREEN_WIDTH // 2 - inst_bonus.get_width() // 2, SCREEN_HEIGHT // 2 + 65))
        screen.blit(inst_bomb, (SCREEN_WIDTH // 2 - inst_bomb.get_width() // 2, SCREEN_HEIGHT // 2 + 95))
        screen.blit(inst_shield, (SCREEN_WIDTH // 2 - inst_shield.get_width() // 2, SCREEN_HEIGHT // 2 + 125))

    elif game_state == STATE_GAMEOVER:
        overlay = pygame.Surface((SCREEN_WIDTH, SCREEN_HEIGHT), pygame.SRCALPHA)
        overlay.fill((10, 0, 0, 200))
        screen.blit(overlay, (0, 0))

        game_over_surf = large_font.render("GAME OVER", True, RED)
        final_score_surf = font.render(f"Final Score: {score}", True, WHITE)
        restart_surf = font.render("Press SPACE or 'R' to Play Again", True, CYAN)

        screen.blit(game_over_surf, (SCREEN_WIDTH // 2 - game_over_surf.get_width() // 2, SCREEN_HEIGHT // 2 - 80))
        screen.blit(final_score_surf, (SCREEN_WIDTH // 2 - final_score_surf.get_width() // 2, SCREEN_HEIGHT // 2 - 20))
        screen.blit(restart_surf, (SCREEN_WIDTH // 2 - restart_surf.get_width() // 2, SCREEN_HEIGHT // 2 + 30))

    pygame.display.flip()

pygame.quit()
sys.exit()
