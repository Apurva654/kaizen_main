import pygame
import random
import sys

pygame.init()

SCREEN_WIDTH = 800
SCREEN_HEIGHT = 600
screen = pygame.display.set_mode((SCREEN_WIDTH, SCREEN_HEIGHT))
pygame.display.set_caption("Star Catcher")

# Colors
DARK_BLUE = (10, 10, 35)
WHITE = (255, 255, 255)
YELLOW = (255, 215, 0)
BROWN = (139, 69, 19)
RED = (220, 20, 60)

clock = pygame.time.Clock()

# Game State Variables
score = 0
lives = 3
game_over = False

# Basket properties
basket_width = 100
basket_height = 30
basket_x = SCREEN_WIDTH // 2 - basket_width // 2
basket_y = SCREEN_HEIGHT - 60
basket_speed = 8

# Star properties
star_radius = 15
star_x = random.randint(star_radius, SCREEN_WIDTH - star_radius)
star_y = -50
star_speed = 4

font = pygame.font.SysFont(None, 36)
large_font = pygame.font.SysFont(None, 64)

def reset_game():
    global score, lives, game_over, basket_x, star_x, star_y, star_speed
    score = 0
    lives = 3
    game_over = False
    basket_x = SCREEN_WIDTH // 2 - basket_width // 2
    star_x = random.randint(star_radius, SCREEN_WIDTH - star_radius)
    star_y = -50
    star_speed = 4

running = True
while running:
    screen.fill(DARK_BLUE)

    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False
        elif event.type == pygame.KEYDOWN:
            if game_over and event.key == pygame.K_r:
                reset_game()

    if not game_over:
        # Handle continuous key presses for basket movement
        keys = pygame.key.get_pressed()
        if keys[pygame.K_LEFT]:
            basket_x -= basket_speed
            if basket_x < 0:
                basket_x = 0
        if keys[pygame.K_RIGHT]:
            basket_x += basket_speed
            if basket_x > SCREEN_WIDTH - basket_width:
                basket_x = SCREEN_WIDTH - basket_width

        # Move the star down
        star_y += star_speed

        # Check for catch
        basket_rect = pygame.Rect(basket_x, basket_y, basket_width, basket_height)
        star_rect = pygame.Rect(star_x - star_radius, star_y - star_radius, star_radius * 2, star_radius * 2)

        if basket_rect.colliderect(star_rect):
            score += 1
            star_x = random.randint(star_radius, SCREEN_WIDTH - star_radius)
            star_y = -50
            star_speed += 0.2  # Slightly increase speed as score increases

        # Check if star missed
        elif star_y > SCREEN_HEIGHT + star_radius:
            lives -= 1
            star_x = random.randint(star_radius, SCREEN_WIDTH - star_radius)
            star_y = -50
            if lives <= 0:
                game_over = True

    # Draw Basket (Trapezoid/Rectangle primitive)
    pygame.draw.rect(screen, BROWN, (basket_x, basket_y, basket_width, basket_height), border_radius=5)
    # Basket handle / rim detail
    pygame.draw.rect(screen, (160, 82, 45), (basket_x - 5, basket_y, basket_width + 10, 8), border_radius=3)

    # Draw Star (Circle primitive for simplicity or multi-point polygon)
    pygame.draw.circle(screen, YELLOW, (int(star_x), int(star_y)), star_radius)

    # Render Score and Lives
    score_text = font.render(f"Score: {score}", True, WHITE)
    lives_text = font.render(f"Lives: {lives}", True, RED)
    screen.blit(score_text, (20, 20))
    screen.blit(lives_text, (SCREEN_WIDTH - 140, 20))

    # Game Over Screen
    if game_over:
        overlay = pygame.Surface((SCREEN_WIDTH, SCREEN_HEIGHT), pygame.SRCALPHA)
        overlay.fill((0, 0, 0, 180))
        screen.blit(overlay, (0, 0))

        game_over_surf = large_font.render("GAME OVER", True, RED)
        restart_surf = font.render("Press 'R' to Restart or Close Window", True, WHITE)
        
        screen.blit(game_over_surf, (SCREEN_WIDTH // 2 - game_over_surf.get_width() // 2, SCREEN_HEIGHT // 2 - 60))
        screen.blit(restart_surf, (SCREEN_WIDTH // 2 - restart_surf.get_width() // 2, SCREEN_HEIGHT // 2 + 10))

    pygame.display.flip()
    clock.tick(60)

pygame.quit()
sys.exit()
