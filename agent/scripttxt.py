import os

# Set the correct directory path
dir_path = '/Users/antonio/AI/eliza/agent/knowledge13'  # Update this path as needed

# Loop through all files in the directory
for filename in os.listdir(dir_path):
    file_path = os.path.join(dir_path, filename)

    # Check if it's a file (not a subdirectory)
    if os.path.isfile(file_path):
        # Add .txt extension if it doesn't already have one
        if not filename.endswith('.txt'):
            new_file_path = os.path.join(dir_path, filename + '.txt')
            print(f"Renaming {file_path} to {new_file_path}")
            os.rename(file_path, new_file_path)
        else:
            print(f"Skipping {filename}, already has .txt extension")
    else:
        print(f"Skipping {filename}, not a file")
