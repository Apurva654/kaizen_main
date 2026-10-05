import os
import argparse
import numpy as np
import matplotlib
# Use a non‑interactive backend suitable for headless environments
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def generate_random_data(num_points: int):
    """Return two 1‑D arrays: an index array and a matching array of random values.

    Args:
        num_points: Number of random points to generate.
    """
    x = np.arange(num_points)
    y = np.random.rand(num_points)
    return x, y


def plot_random_graph(num_points: int = 100, title: str = "Random Values Graph"):
    """Create a line plot of random values.

    Returns the Matplotlib ``Figure`` and ``Axes`` objects so callers can further
    customise or save the plot.
    """
    x, y = generate_random_data(num_points)
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.plot(x, y, marker='o', linestyle='-', color='tab:blue')
    ax.set_title(title)
    ax.set_xlabel('Index')
    ax.set_ylabel('Random Value')
    ax.grid(True, which='both', linestyle='--', linewidth=0.5)
    return fig, ax


def save_graph(fig: plt.Figure, filepath: str):
    """Save the supplied figure to *filepath* and close the figure to free memory."""
    # Ensure the directory exists
    os.makedirs(os.path.dirname(os.path.abspath(filepath)) or '.', exist_ok=True)
    fig.savefig(filepath, bbox_inches='tight')
    plt.close(fig)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate and save a random values graph.")
    parser.add_argument("-n", "--num-points", type=int, default=100,
                        help="Number of random points to plot (default: 100)")
    parser.add_argument("-o", "--output", type=str, default="random_graph.png",
                        help="Path to the output image file (default: random_graph.png)")
    args = parser.parse_args()

    fig, _ = plot_random_graph(num_points=args.num_points)
    save_graph(fig, args.output)
    print(f"Graph saved to {os.path.abspath(args.output)}")
